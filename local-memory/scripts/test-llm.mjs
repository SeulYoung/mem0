#!/usr/bin/env node
/**
 * Verifies the properties that are easy to get wrong once a model sits between
 * a prompt and the store.
 *
 * Part 1 (free, deterministic, runs even with the model off): mem0 decides what
 * is a *new* fact by searching existing memories and handing them to the model,
 * so that search must be scoped to the current repository. A stub model records
 * the prompt mem0 builds and we assert on which memories are in it.
 *
 * Part 2 (3 model calls, ~50s): the real model answers mem0's strict output
 * schema through our prompt reshaping, extraction really produces facts, keeps
 * our metadata, and a resubmitted input costs nothing.
 */
import fs from "node:fs";
import path from "node:path";

import { createEmbedder } from "../src/embedder.mjs";
import { loadConfig } from "../src/config.mjs";
import {
  addMemory,
  deleteMemory,
  historyDbFor,
  listMemories,
  memoryConfig,
  routeConsoleToStderr,
  scopeFilters,
} from "../src/memory.mjs";
import { PATHS } from "../src/paths.mjs";

routeConsoleToStderr();

const config = loadConfig();
const out = (line) => process.stdout.write(`${line}\n`);
const show = (label, value) => out(`\n== ${label}\n${JSON.stringify(value, null, 2)}`);

const projectA = { id: "llm-test-alpha", name: "llm-test-alpha", root: "C:\\nonexistent\\alpha" };
const projectB = { id: "llm-test-beta", name: "llm-test-beta", root: "C:\\nonexistent\\beta" };

const VERBOSE =
  "先帮我看一下这个报错，另外记一下：ALPHA 模块的构建必须走 build-alpha-9527.bat 这个脚本，" +
  "不允许直接调用 UBT 命令行，之前有人直接调导致产物不一致。";

function modelCalls() {
  try {
    const usage = JSON.parse(fs.readFileSync(path.join(PATHS.home, "llm-usage.json"), "utf8"));
    return usage.day === new Date().toISOString().slice(0, 10) ? usage.calls : 0;
  } catch {
    return 0;
  }
}

const created = [];
let failures = 0;
const check = (label, ok, detail) => {
  out(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

/**
 * Part 1 — deterministic and free. A stub model records the prompt mem0 builds,
 * which is the only way to see which existing memories mem0 decided are in
 * scope. Costs nothing, so it runs even with the model turned off.
 */
async function checkExtractionScope() {
  const { Memory } = await import("mem0ai/oss");
  const prompts = [];
  const recorder = {
    model: "recorder",
    async invoke(messages) {
      prompts.push(
        (messages ?? [])
          .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
          .join("\n"),
      );
      // Empty under either key mem0 might read, so the run ends after extraction.
      return { content: '{"facts": [], "memory": []}' };
    },
  };
  const embedder = createEmbedder(config);
  // Built exactly like the real instances, per project, so the history database
  // (which is where mem0 keeps the messages it replays) is scoped the same way.
  const probes = new Map(
    [projectA, projectB].map((project) => [
      project.id,
      new Memory(memoryConfig({ config, embedder, llm: recorder, historyDbPath: historyDbFor(project) })),
    ]),
  );

  const PLANTED = "项目 ALPHA 的灰度开关叫 alpha_rollout_7788，只能由发布负责人改动。";
  const planted = await addMemory({
    text: PLANTED,
    project: projectA,
    kind: "convention",
    source: "test:llm",
  });
  created.push(...planted.map((record) => record.id));

  // Deliberately different from PLANTED: if the planted text shows up in the
  // prompt at all, it got there as context, not as the input.
  const INPUT = "再记一条：发布前必须跑一遍冒烟测试，负责人是当班的值班同学。";

  const askedFor = async (project) => {
    prompts.length = 0;
    await probes.get(project.id).add(INPUT, {
      userId: config.userId,
      filters: scopeFilters(config, project, "project"),
      metadata: { project: project.id, project_name: project.name, kind: "convention", source: "test:llm" },
      infer: true,
    });
    return prompts.join("\n");
  };

  const forA = await askedFor(projectA);
  check(
    "extraction context includes this repository's own memories",
    forA.includes("alpha_rollout_7788"),
    "scoping must not filter out the memories that make dedup work",
  );

  // Project A's call left its input in project A's message history; project B's
  // prompt must show neither the memory nor that message.
  const forB = await askedFor(projectB);
  const section = (prompt, heading) => prompt.split(`## ${heading}`)[1]?.split("\n## ")[0] ?? "";
  check(
    "extraction context excludes another repository's memories",
    !section(forB, "Existing Memories").includes("alpha_rollout_7788"),
    "mem0 searches existing memories to decide what is new — unscoped, dedup drops facts across repositories",
  );
  check(
    "replayed messages exclude another repository's prompts",
    !section(forB, "Last k Messages").includes("值班同学"),
    "mem0 replays recent messages into the prompt, scoped only by user — hence one history database per repository",
  );
  const at = forB.indexOf("alpha_rollout_7788");
  check(
    "nothing from the other repository anywhere in the prompt",
    at < 0,
    at < 0 ? "" : `found at ${at}: ...${forB.slice(Math.max(0, at - 240), at + 60)}...`,
  );
}

/** Remove per-project history databases created by the tests. */
function cleanHistory() {
  for (const project of [projectA, projectB]) {
    const file = historyDbFor(project);
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.rmSync(`${file}${suffix}`, { force: true });
      } catch {
        // still open on Windows; harmless leftovers
      }
    }
  }
}

try {
  // Start from a clean slate: SQLite files stay locked until the process that
  // opened them exits, so a previous run's teardown may not have removed them.
  cleanHistory();
  for (const project of [projectA, projectB]) {
    for (const record of await listMemories({ project, limit: 100, scope: "project" })) {
      await deleteMemory(record.id, project);
    }
  }

  await checkExtractionScope();

  if (!config.llm?.enabled) {
    out("\nllm.enabled is false — skipping the live model checks.");
  } else {
    await checkLiveModel();
  }
  out(failures === 0 ? "\nLLM path verified." : `\n${failures} check(s) failed.`);
} finally {
  for (const project of [projectA, projectB]) {
    for (const record of await listMemories({ project, limit: 100, scope: "project" })) {
      await deleteMemory(record.id, project);
      created.push(record.id);
    }
  }
  cleanHistory();
  show("cleaned up", [...new Set(created)]);
}

/**
 * mem0 validates the model's reply against a strict schema (each item needs a
 * string `id` and `text`; `attributed_to` and `linked_memory_ids` are optional)
 * and only falls back to a lenient parse if that throws. This layer reshapes
 * mem0's two messages into one CLI prompt, so the check that matters is whether
 * the real model still answers mem0's contract through that reshaping.
 */
async function checkModelHonoursSchema() {
  const { Memory } = await import("mem0ai/oss");
  const { createLlm } = await import("../src/llm.mjs");
  const bridge = createLlm(config);
  const replies = [];
  let promptChars = 0;
  const spy = {
    model: bridge.info.model,
    async invoke(messages) {
      promptChars = (messages ?? []).reduce((total, message) => total + String(message.content ?? "").length, 0);
      const reply = await bridge.invoke(messages);
      replies.push(reply.content);
      return reply;
    },
  };

  const memory = new Memory(
    memoryConfig({ config, embedder: createEmbedder(config), llm: spy, historyDbPath: historyDbFor(projectB) }),
  );
  const result = await memory.add(
    "顺便记一下：这个仓库的资源打包统一走 cook-assets.ps1，别直接调 UnrealPak。",
    {
      userId: config.userId,
      filters: scopeFilters(config, projectB, "project"),
      metadata: { project: projectB.id, project_name: projectB.name, kind: "convention", source: "test:llm" },
      infer: true,
    },
  );
  created.push(...(result?.results ?? []).map((item) => item.id));

  check("the model replied at all", replies.length === 1, `${replies.length} reply/replies`);

  // mem0's extraction prompt is far past the 32767-character Windows command
  // line, so the transport has to carry it some other way. It travels on stdin;
  // the file-based alternative gets refused as a prompt injection often enough
  // to matter, and each refusal silently downgrades a capture to verbatim.
  check(
    "the transport carried a prompt no command line could hold",
    promptChars > 32767,
    `${promptChars} chars`,
  );
  check(
    "the model treated it as a task rather than as suspicious content",
    !/prompt[- ]injection|not going to (execute|follow)|isn't a legitimate/i.test(replies[0] ?? ""),
    (replies[0] ?? "").slice(0, 160),
  );

  let parsed;
  try {
    // Same cleanup mem0 does before validating: strip fences, then parse.
    parsed = JSON.parse(replies[0].replace(/```(?:\w+)?\n?([\s\S]*?)(?:```|$)/g, "$1").trim());
  } catch (error) {
    parsed = null;
    out(`   raw reply: ${replies[0]?.slice(0, 300)}`);
  }
  check("the reply is a JSON object", Boolean(parsed) && typeof parsed === "object");
  check("it uses mem0's `memory` array", Array.isArray(parsed?.memory), JSON.stringify(Object.keys(parsed ?? {})));
  check(
    "every item satisfies mem0's strict schema (string id + text)",
    Array.isArray(parsed?.memory) &&
      parsed.memory.length > 0 &&
      parsed.memory.every((item) => typeof item.id === "string" && typeof item.text === "string"),
    JSON.stringify(parsed?.memory?.map((item) => ({ id: item.id, attributed_to: item.attributed_to }))),
  );
  check(
    "optional fields, when present, use mem0's vocabulary",
    (parsed?.memory ?? []).every(
      (item) =>
        (item.attributed_to === undefined || ["user", "assistant"].includes(item.attributed_to)) &&
        (item.linked_memory_ids === undefined || Array.isArray(item.linked_memory_ids)),
    ),
  );
}

/**
 * The store and its embedding model are English-only, so the language policy in
 * `llm.customInstructions` is what makes captured prompts retrievable at all.
 * This drives the real `beforeSubmitPrompt` hook with a Chinese prompt and
 * asserts what actually landed in the store.
 */
async function checkCapturedPromptIsEnglish() {
  const { spawn } = await import("node:child_process");
  const os = await import("node:os");
  const { resolveProject } = await import("../src/project.mjs");

  const root = path.join(os.tmpdir(), "mem0-language-probe");
  fs.mkdirSync(root, { recursive: true });
  const project = resolveProject(root);
  for (const record of await listMemories({ project, limit: 50, scope: "project" })) {
    await deleteMemory(record.id, project);
  }

  const CHINESE_PROMPT =
    "顺手记一下：这个仓库的资源打包只能走 pack-assets-4471.ps1，" +
    "不要直接调用 UnrealPak，之前有人直调导致产物不一致。";

  const { fileURLToPath } = await import("node:url");
  const hookPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "hooks", "before-submit-prompt.mjs");
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("close", () => resolve());
    child.stdin.end(
      JSON.stringify({
        conversation_id: "language-probe",
        hook_event_name: "beforeSubmitPrompt",
        prompt: CHINESE_PROMPT,
        workspace_roots: [root],
        attachments: [],
      }),
    );
  });

  // The worker is detached and calls the model, so give it room.
  let stored = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    stored = await listMemories({ project, limit: 10, scope: "project" });
    if (stored.length > 0) break;
  }

  check("a captured prompt reaches the store", stored.length > 0);
  if (stored.length === 0) return;
  out(`   stored: ${stored.map((record) => record.text).join(" | ")}`);
  check(
    "the captured Chinese prompt was stored in English",
    stored.every((record) => !/[\u4e00-\u9fff]/.test(record.text)),
    "the embedding model is English-only, so stored Chinese is close to unretrievable",
  );
  check(
    "the identifier survived translation verbatim",
    stored.some((record) => record.text.includes("pack-assets-4471.ps1")),
    stored.map((record) => record.text).join(" | "),
  );

  for (const record of stored) await deleteMemory(record.id, project);
}

/** Part 2 — the only suite that spends tokens: 4 model calls, roughly 70s. */
async function checkLiveModel() {
  await checkCapturedPromptIsEnglish();
  await checkModelHonoursSchema();
  const callsBefore = modelCalls();

  const inA = await addMemory({
    text: VERBOSE,
    project: projectA,
    kind: "convention",
    source: "test:llm",
    infer: true,
    dedupeKey: "llm-test-fixed-hash",
  });
  created.push(...inA.map((record) => record.id));
  show("extracted in project A", inA);

  check("extraction returned at least one fact", inA.length > 0);
  check(
    "extraction dropped the throwaway request",
    inA.every((record) => !record.text.includes("看一下这个报错")),
  );
  check(
    "extraction kept the concrete identifier",
    inA.some((record) => record.text.includes("build-alpha-9527.bat")),
    inA.map((r) => r.text).join(" | "),
  );

  // Metadata has to survive the extraction path, otherwise project isolation
  // silently breaks for every memory the model writes.
  const storedA = await listMemories({ project: projectA, limit: 50, scope: "project" });
  check(
    "stored records carry project + kind metadata",
    storedA.length > 0 && storedA.every((r) => r.project === projectA.id && r.kind === "convention"),
    JSON.stringify(storedA.map((r) => ({ project: r.project, kind: r.kind }))),
  );

  // The regression this exists for: without scoped filters, mem0 would show the
  // model project A's memory and it would answer "already captured".
  const inB = await addMemory({
    text: VERBOSE,
    project: projectB,
    kind: "convention",
    source: "test:llm",
    infer: true,
  });
  created.push(...inB.map((record) => record.id));
  show("extracted in project B (same input, different repository)", inB);
  check(
    "another repository's memories do not suppress the fact",
    inB.length > 0,
    inB.length === 0 ? "project A's copy leaked into project B's extraction context" : "",
  );

  const callsAfterExtractions = modelCalls();
  check(
    "each extraction was exactly one model call",
    callsAfterExtractions - callsBefore === 2,
    `delta=${callsAfterExtractions - callsBefore}`,
  );

  // Same input again in project A: must short-circuit before the model.
  const repeat = await addMemory({
    text: VERBOSE,
    project: projectA,
    kind: "convention",
    source: "test:llm",
    infer: true,
    dedupeKey: "llm-test-fixed-hash",
  });
  check("resubmitting the same input stores nothing", repeat.length === 0);
  check(
    "resubmitting the same input costs no model call",
    modelCalls() - callsAfterExtractions === 0,
    `delta=${modelCalls() - callsAfterExtractions}`,
  );
}

process.exit(failures === 0 ? 0 : 1);
