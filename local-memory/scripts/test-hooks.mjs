#!/usr/bin/env node
/**
 * Drives all four Cursor hooks with realistic payloads and verifies the
 * observable behaviour: a turn is captured exactly once and only when it ends,
 * the agent's reply travels with the prompt, an unfinished turn is flushed rather
 * than lost, short prompts are ignored, payloads with a BOM still parse, nested
 * summarisation agents are not captured, and sessionStart injects what was stored.
 *
 * The model is off throughout (assertions compare stored text to the prompt
 * verbatim), and with no model there is no extraction to hand a message pair to —
 * so the reply is asserted where it is observable without one: in the parked turn
 * file and in the queued job the `stop` hook produces.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { deleteMemory, listMemories, routeConsoleToStderr } from "../src/memory.mjs";
import { INTERNAL_ENV_MARKER } from "../src/llm.mjs";
import { PATHS } from "../src/paths.mjs";
import { resolveProject } from "../src/project.mjs";

routeConsoleToStderr();

// Assertions below compare stored text against the prompt verbatim, so the
// summarisation model has to stay out of it. Also keeps this suite fast and free.
process.env.MEM0_LOCAL_NO_LLM = "1";

const here = path.dirname(fileURLToPath(import.meta.url));
const hook = (name) => path.join(here, "..", "src", "hooks", `${name}.mjs`);
const projectRoot = process.argv[2] ?? path.join(here, "..", "..");
const project = resolveProject(projectRoot);

const show = (label, value) => process.stdout.write(`\n== ${label}\n${JSON.stringify(value, null, 2)}\n`);

function runHook(name, payload, { raw, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hook(name)], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...(env ?? {}) },
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolve({ code, json: out.trim() ? JSON.parse(out) : {} });
      } catch (error) {
        reject(new Error(`${name} produced non-JSON output: ${out.slice(0, 200)} (${error.message})`));
      }
    });
    child.stdin.end(raw ?? JSON.stringify(payload));
  });
}

const common = {
  conversation_id: "test-conversation",
  generation_id: "test-generation",
  cursor_version: "test",
  workspace_roots: [projectRoot],
  user_email: null,
  transcript_path: null,
};

const PROMPT = "本地记忆 hook 自检：请记住我们约定用 conventional commits 提交信息，并且优先用中文回答。";
const REPLY = "本地记忆 hook 自检：这是 agent 的回答，结论在最后一句——构建脚本必须先跑 10.BuildPC.bat。";
const BOM_PROMPT = "本地记忆 hook 自检：带 BOM 的载荷也必须能被解析并记录下来，这是回归测试。";
const NESTED_PROMPT = "本地记忆 hook 自检：这条来自嵌套总结 agent，必须被跳过而不是记录。";
const ABANDONED_PROMPT = "本地记忆 hook 自检：这一轮永远收不到 stop，必须由下一条 prompt 把它冲出去。";
/** Longer than the whole reply budget on its own, which is the point. */
const LONG_PROMPT_HEAD = "本地记忆 hook 自检：这是一段很长的前言。".repeat(150);

const turnFile = (conversationId) => path.join(PATHS.turnsDir, `${conversationId}.ndjson`);
const parkedTurn = (conversationId) => {
  try {
    return fs.readFileSync(turnFile(conversationId), "utf8");
  } catch {
    return null;
  }
};

const submit = (prompt, conversationId, options) =>
  runHook(
    "before-submit-prompt",
    { ...common, conversation_id: conversationId, hook_event_name: "beforeSubmitPrompt", prompt, attachments: [] },
    options,
  );
const reply = (text, conversationId, options) =>
  runHook(
    "after-agent-response",
    { ...common, conversation_id: conversationId, hook_event_name: "afterAgentResponse", text },
    options,
  );
const endTurn = (conversationId, options) =>
  runHook(
    "stop",
    { ...common, conversation_id: conversationId, hook_event_name: "stop", status: "completed", loop_count: 0 },
    options,
  );

async function waitForCapture(text, timeoutMs = 60000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const found = (await listMemories({ project, limit: 50, scope: "project" })).find((record) => record.text === text);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return null;
}

const created = [];
try {
  show("project under test", project);

  const sent = await submit(PROMPT, "test-turn");
  show("beforeSubmitPrompt response", sent);
  if (sent.json.continue !== true) throw new Error("hook must let the prompt through");

  // Nothing may be stored yet: the turn is what gets recorded, and it has not
  // ended. Writing here would mean the reply could never join the same memory.
  const parkedPrompt = parkedTurn("test-turn");
  show("parked turn after the prompt", parkedPrompt);
  if (!parkedPrompt?.includes(PROMPT)) throw new Error("the prompt was not parked as a turn in flight");
  const early = (await listMemories({ project, limit: 50, scope: "project" })).filter((r) => r.text === PROMPT);
  if (early.length !== 0) throw new Error("the prompt was stored before its turn ended");

  const answered = await reply(REPLY, "test-turn");
  show("afterAgentResponse response", answered);
  const parkedReply = parkedTurn("test-turn");
  if (!parkedReply?.includes(REPLY)) throw new Error("the agent's reply did not join the turn");

  const ended = await endTurn("test-turn");
  show("stop response", ended);
  if (ended.json.followup_message !== undefined) throw new Error("the stop hook must never submit a follow-up");

  // Model off, so the turn is stored verbatim from the prompt: the reply only has
  // somewhere to go on the extraction path (asserted in test-llm.mjs).
  const captured = await waitForCapture(PROMPT);
  show("captured record", captured);
  if (!captured) throw new Error("the finished turn was never written to the store");
  created.push(captured.id);
  if (parkedTurn("test-turn") !== null) throw new Error("the turn file outlived the turn it held");

  const againSent = await submit(PROMPT, "test-turn-again");
  await reply(REPLY, "test-turn-again");
  await endTurn("test-turn-again");
  show("second identical turn", againSent);
  await new Promise((resolve) => setTimeout(resolve, 6000));
  const copies = (await listMemories({ project, limit: 50, scope: "project" })).filter(
    (record) => record.text === PROMPT,
  );
  show("copies after resubmitting the same prompt", copies.length);
  if (copies.length !== 1) throw new Error(`expected exactly one copy, found ${copies.length}`);

  const short = await submit("ok", "test-short");
  show("beforeSubmitPrompt (too short) response", short);
  if (parkedTurn("test-short") !== null) throw new Error("a prompt below minChars started a turn anyway");

  // capture.maxChars (4000) is larger than the reply budget, so a reply budget
  // measured against the file rather than against the replies would make every
  // long prompt lose its reply — silently, and only for long prompts.
  await submit(`${LONG_PROMPT_HEAD}${PROMPT}`, "test-long");
  await reply(REPLY, "test-long");
  const parkedLong = parkedTurn("test-long");
  show("long prompt keeps its reply", parkedLong?.length);
  if (!parkedLong?.includes(REPLY)) throw new Error("a long prompt rejected the reply of its own turn");

  // A turn whose `stop` never arrives — the window was closed mid-answer. The
  // next prompt in the same conversation has to write it, not discard it.
  await submit(ABANDONED_PROMPT, "test-abandoned");
  await reply(REPLY, "test-abandoned");
  await submit(BOM_PROMPT, "test-abandoned");
  const abandoned = await waitForCapture(ABANDONED_PROMPT);
  show("flushed unfinished turn", abandoned);
  if (!abandoned) throw new Error("an unfinished turn was dropped instead of flushed");
  created.push(abandoned.id);

  // The Cursor CLI on Windows prefixes hook payloads with a UTF-8 BOM. This one
  // also happens to be the turn the flush above left parked.
  const withBom = await runHook(
    "stop",
    {},
    {
      raw: `\uFEFF${JSON.stringify({
        ...common,
        conversation_id: "test-abandoned",
        hook_event_name: "stop",
        status: "completed",
        loop_count: 0,
      })}`,
    },
  );
  show("stop (BOM payload) response", withBom);
  const bomCaptured = await waitForCapture(BOM_PROMPT);
  show("captured through a BOM payload", bomCaptured);
  if (!bomCaptured) throw new Error("payload with a BOM was dropped");
  created.push(bomCaptured.id);

  // A capture here would feed the summariser its own prompt, forever.
  const nested = await submit(NESTED_PROMPT, "test-nested", { env: { [INTERNAL_ENV_MARKER]: "1" } });
  show("beforeSubmitPrompt (nested agent) response", nested);
  if (parkedTurn("test-nested") !== null) throw new Error("a nested summarisation agent started a turn");
  await reply(NESTED_PROMPT, "test-nested", { env: { [INTERNAL_ENV_MARKER]: "1" } });
  await endTurn("test-nested", { env: { [INTERNAL_ENV_MARKER]: "1" } });
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const nestedStored = (await listMemories({ project, limit: 50, scope: "project" })).filter(
    (record) => record.text === NESTED_PROMPT,
  );
  show("stored from nested agent (must be 0)", nestedStored.length);
  if (nestedStored.length !== 0) {
    created.push(...nestedStored.map((record) => record.id));
    throw new Error("a nested summarisation agent got its prompt captured");
  }

  const session = await runHook("session-start", {
    ...common,
    hook_event_name: "sessionStart",
    session_id: "test-session",
    is_background_agent: false,
    composer_mode: "agent",
  });
  show("sessionStart response", session);
  if (typeof session.json.additional_context !== "string") throw new Error("sessionStart must return additional_context");
  process.stdout.write(`\n--- injected context ---\n${session.json.additional_context}\n------------------------\n`);

  process.stdout.write("\nHook test passed.\n");
} finally {
  for (const id of created) await deleteMemory(id);
  if (created.length > 0) show("cleaned up", created);
  // Only this suite's own conversations: a turn parked by a real session is
  // somebody's unrecorded prompt.
  for (const name of ["test-turn", "test-turn-again", "test-short", "test-long", "test-abandoned", "test-nested"]) {
    try {
      fs.unlinkSync(turnFile(name));
    } catch {
      // already flushed
    }
  }
}
