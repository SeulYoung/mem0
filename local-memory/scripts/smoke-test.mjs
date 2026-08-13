#!/usr/bin/env node
/**
 * End-to-end check of the local memory stack: config -> embedder -> store ->
 * search -> list -> stats. Safe to re-run; it cleans up the records it writes.
 */
import { ensureConfigFile, loadConfig } from "../src/config.mjs";
import {
  addMemory,
  deleteMemory,
  detectDimension,
  listMemories,
  routeConsoleToStderr,
  searchMemories,
  statsMemories,
} from "../src/memory.mjs";
import { PATHS } from "../src/paths.mjs";
import { resolveProject } from "../src/project.mjs";

routeConsoleToStderr();

const step = (name) => process.stdout.write(`\n== ${name}\n`);
const show = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

const config = ensureConfigFile();
step("config");
show({ dataDir: PATHS.home, userId: config.userId, embedder: config.embedder, llmEnabled: config.llm.enabled });

step("config constraints");
// mem0 rejects entity ids that are empty or contain whitespace, and the memory
// owner defaults to the OS account name — which on Windows regularly has a
// space in it. Unnormalised, that account would fail on every single write.
process.env.MEM0_LOCAL_USER_ID = "Smoke Test User";
const normalized = loadConfig().userId;
delete process.env.MEM0_LOCAL_USER_ID;
if (normalized !== "Smoke-Test-User") {
  throw new Error(`a user name with spaces must be normalised into a valid mem0 entity id; got "${normalized}"`);
}
if (/\s/.test(config.userId)) throw new Error(`mem0 would reject the configured userId "${config.userId}"`);
show({ userId: config.userId, normalizedExample: normalized });

const project = resolveProject(process.argv[2]);
step("project");
show(project);

step("write guards");
// mem0 stores any `kind` it is handed, so a typo there is not an error — the
// memory is simply never injected again, because injection filters on
// `inject.kinds`. Silent for the memory's whole life unless we refuse it here.
const refused = async (label, run) => {
  try {
    await run();
    throw new Error(`${label}: the write went through`);
  } catch (error) {
    if (/the write went through/.test(error.message)) throw error;
    return `${label}: ${error.message}`;
  }
};
show([
  await refused("unknown kind", () => addMemory({ text: "guard probe", project, kind: "notekind" })),
  await refused("empty text", () => addMemory({ text: "   ", project })),
]);

step("embedding dimension (first run downloads the model)");
const started = Date.now();
const dimension = await detectDimension();
show({ dimension, elapsedMs: Date.now() - started });

step("add");
const written = [];
written.push(
  ...(await addMemory({
    text: "本地记忆冒烟测试：这台机器上偏好使用 pnpm 而不是 npm。",
    project,
    kind: "preference",
    source: "smoke-test",
  })),
);
written.push(
  ...(await addMemory({
    text: "Smoke test: prefers TypeScript strict mode in every new package.",
    project,
    kind: "preference",
    source: "smoke-test",
    global: true,
  })),
);
show(written);

step("search (zh query)");
show(await searchMemories({ query: "包管理器用哪个", project, topK: 3 }));

step("search (en query)");
show(await searchMemories({ query: "typescript settings", project, topK: 3 }));

step("list");
show(await listMemories({ project, limit: 5 }));

step("stats");
show(await statsMemories());

step("cleanup");
for (const record of written) await deleteMemory(record.id);
show({ deleted: written.map((record) => record.id) });

process.stdout.write("\nSmoke test finished.\n");
