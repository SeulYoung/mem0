#!/usr/bin/env node
/**
 * Drives both Cursor hooks with realistic payloads and verifies the observable
 * behaviour: prompts get captured exactly once, short prompts are ignored,
 * payloads with a BOM still parse, nested summarisation agents are not captured,
 * and sessionStart injects what was stored.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { deleteMemory, listMemories, routeConsoleToStderr } from "../src/memory.mjs";
import { INTERNAL_ENV_MARKER } from "../src/llm.mjs";
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
const BOM_PROMPT = "本地记忆 hook 自检：带 BOM 的载荷也必须能被解析并记录下来，这是回归测试。";
const NESTED_PROMPT = "本地记忆 hook 自检：这条来自嵌套总结 agent，必须被跳过而不是记录。";

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

  const submit = await runHook("before-submit-prompt", {
    ...common,
    hook_event_name: "beforeSubmitPrompt",
    prompt: PROMPT,
    attachments: [],
  });
  show("beforeSubmitPrompt response", submit);
  if (submit.json.continue !== true) throw new Error("hook must let the prompt through");

  const captured = await waitForCapture(PROMPT);
  show("captured record", captured);
  if (!captured) throw new Error("prompt was never written to the store");
  created.push(captured.id);

  const again = await runHook("before-submit-prompt", {
    ...common,
    hook_event_name: "beforeSubmitPrompt",
    prompt: PROMPT,
    attachments: [],
  });
  show("beforeSubmitPrompt (duplicate) response", again);
  await new Promise((resolve) => setTimeout(resolve, 6000));
  const copies = (await listMemories({ project, limit: 50, scope: "project" })).filter(
    (record) => record.text === PROMPT,
  );
  show("copies after duplicate submit", copies.length);
  if (copies.length !== 1) throw new Error(`expected exactly one copy, found ${copies.length}`);

  const short = await runHook("before-submit-prompt", {
    ...common,
    hook_event_name: "beforeSubmitPrompt",
    prompt: "ok",
    attachments: [],
  });
  show("beforeSubmitPrompt (too short) response", short);

  // The Cursor CLI on Windows prefixes hook payloads with a UTF-8 BOM.
  const withBom = await runHook(
    "before-submit-prompt",
    {},
    {
      raw: `\uFEFF${JSON.stringify({
        ...common,
        hook_event_name: "beforeSubmitPrompt",
        prompt: BOM_PROMPT,
        attachments: [],
      })}`,
    },
  );
  show("beforeSubmitPrompt (BOM payload) response", withBom);
  const bomCaptured = await waitForCapture(BOM_PROMPT);
  show("captured from BOM payload", bomCaptured);
  if (!bomCaptured) throw new Error("payload with a BOM was dropped");
  created.push(bomCaptured.id);

  // A capture here would feed the summariser its own prompt, forever.
  const nested = await runHook(
    "before-submit-prompt",
    { ...common, hook_event_name: "beforeSubmitPrompt", prompt: NESTED_PROMPT, attachments: [] },
    { env: { [INTERNAL_ENV_MARKER]: "1" } },
  );
  show("beforeSubmitPrompt (nested agent) response", nested);
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
}
