#!/usr/bin/env node
/** Real MCP and mem0 reads in a disposable store. No LLM or ranking benchmark.
 * Uses a copy of the cached English embedding model; never writes production data.
 * node scripts/test-mcp-reads.mjs [path-to-fast-bge-small-en-v1.5-cache] [--compat]
 * --compat also runs the existing MCP and CLI suites in a second empty store.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mem0-read-test-"));
const clients = [];
const server = fileURLToPath(new URL("../src/mcp-server.mjs", import.meta.url));
const model = "fast-bge-small-en-v1.5";
const cachedModel = process.argv.slice(2).find((arg) => arg !== "--compat") ??
  path.join(os.homedir(), ".mem0-local", "models", model);
let checks = 0;

async function connect(directory, user = "read-test-user", home = path.join(root, "store")) {
  fs.mkdirSync(directory, { recursive: true });
  const client = new Client({ name: "read-test", version: "1.0.0" });
  clients.push(client);
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [server, "--project-dir", directory],
    stderr: "pipe",
    env: { ...process.env, MEM0_LOCAL_HOME: home, MEM0_LOCAL_USER_ID: user,
      MEM0_LOCAL_NO_LLM: "1", MEM0_LOCAL_NO_RERANK: "1", MEM0_LOCAL_PROBE: "1" },
  }));
  return client;
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  assert.ok(!result.isError, `${name}: ${text}`);
  return JSON.parse(text);
}

async function fails(client, name, args, pattern) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `${name} should reject ${JSON.stringify(args)}`);
  assert.match(result.content[0].text, pattern);
  checks += 1;
}

try {
  assert.ok(fs.existsSync(cachedModel), `English model cache missing: ${cachedModel}`);
  fs.cpSync(cachedModel, path.join(root, "store", "models", model), { recursive: true });
  const one = await connect(path.join(root, "repo-one"));
  const two = await connect(path.join(root, "repo-two"));
  const otherUser = await connect(path.join(root, "repo-one"), "different-user");
  const catalog = (await one.listTools()).tools;
  for (const name of ["memory_get", "memory_history", "memory_context"]) {
    assert.equal(catalog.find((t) => t.name === name)?.annotations?.readOnlyHint, true, name);
  }
  assert.ok(one.getInstructions().includes("without kind"));
  assert.ok(one.getInstructions().includes("memory_context"));
  assert.ok(one.getInstructions().length <= 512);
  assert.ok(!one.getInstructions().includes("Memory protocol for this session:"));
  const emptyContext = await call(one, "memory_context");
  assert.equal(emptyContext.count, 0);
  assert.ok(emptyContext.text.includes("No eligible memories"));
  assert.ok(emptyContext.text.includes("Memory protocol for this session:"));
  checks += 1;

  const original = "dsdebug constructs dedicated server launch arguments in tools/dsdebug/server/task_manager.py::_build_argv and appends -StressTest.";
  const added = await call(one, "memory_add", { text: original, kind: "fact" });
  const id = added.ids[0];
  assert.equal(added.stored, 1);
  const context = await call(one, "memory_context");
  assert.equal(context.count, 1);
  assert.ok(context.text.includes(original));
  assert.equal(context.project, added.project);
  assert.deepEqual(await call(one, "memory_context"), context, "context can be retrieved again");
  assert.equal((await call(two, "memory_context")).count, 0);
  assert.equal((await call(otherUser, "memory_context")).count, 0);
  const later = await connect(path.join(root, "repo-one"));
  assert.equal(later.getInstructions(), one.getInstructions(), "handshake must not grow with stored memories");
  for (const tool of (await later.listTools()).tools) {
    assert.ok(!JSON.stringify(tool).includes(original));
    assert.ok(!tool.description.includes("Memory protocol for this session:"));
  }
  assert.ok((await call(later, "memory_context")).text.includes(original));
  checks += 1;
  const record = await call(one, "memory_get", { id: id.slice(0, 8).toUpperCase() });
  assert.equal(record.id, id);
  assert.equal(record.text, original);
  assert.equal((await call(one, "memory_get", { id })).id, id);
  const confirmed = await call(one, "memory_update", { id, evidence: "verified",
    confidenceReason: "Verified fixture.", verifiedAt: "2024-01-01T00:00:00Z" });
  const textOnly = await call(one, "memory_update", { id, text: original });
  assert.equal(textOnly.verifiedAt, confirmed.verifiedAt);
  assert.equal(textOnly.evidence, "verified");
  await fails(one, "memory_update", { id, evidence: "verified" }, /confidenceReason/);
  const reconfirmed = await call(one, "memory_update", { id, evidence: "verified", confidenceReason: "Reverified fixture." });
  assert.notEqual(reconfirmed.verifiedAt, confirmed.verifiedAt);
  checks += 1;

  await fails(two, "memory_get", { id }, /No memory.*scope/);
  assert.equal((await call(two, "memory_get", { id, scope: "all" })).text, original);
  await fails(two, "memory_update", { id, text: "Unauthorized correction" }, /another repository/);
  await fails(two, "memory_delete", { id }, /another repository/);
  await fails(two, "memory_history", { id }, /No memory.*scope/);
  await fails(otherUser, "memory_get", { id, scope: "all" }, /No memory.*scope/);
  await fails(otherUser, "memory_history", { id }, /No memory.*scope/);
  await fails(one, "memory_get", { id: "" }, /id is required/);
  await fails(one, "memory_get", { id: "not-present" }, /No memory.*scope/);
  await fails(one, "memory_get", { id, scope: "global" }, /scope/);

  const query = "dsdebug _build_argv DS launch flags";
  const searchArgs = { query, topK: 3 };
  const unfiltered = await call(one, "memory_search", searchArgs);
  assert.ok(unfiltered.results.some((r) => r.id === id));
  assert.ok(unfiltered.results.every((r) => r.scoreDetails === undefined));
  const strict = await call(one, "memory_search", { ...searchArgs, kind: "decision" });
  assert.equal(strict.count, 0, "kind is strict, without implicit fallback");
  const explained = await call(one, "memory_search", { ...searchArgs, explain: true });
  assert.deepEqual(explained.results.map((r) => r.id), unfiltered.results.map((r) => r.id));
  assert.ok(explained.results[0].scoreDetails);
  assert.ok(Object.values(explained.results[0].scoreDetails).some((v) => typeof v === "number"));
  checks += 1;

  const corrected = `${original} It also appends -DisableAutoStartTrace to prevent automatic tracing during stress tests.`;
  await call(one, "memory_update", { id, text: corrected });
  const updatedContext = await call(one, "memory_context");
  assert.ok(updatedContext.text.includes(corrected));
  assert.notEqual(updatedContext.text, context.text, "context is not a startup snapshot");
  assert.equal((await call(one, "memory_get", { id })).text, corrected);
  const history = await call(one, "memory_history", { id: id.slice(0, 8) });
  assert.equal(history.record.text, corrected);
  assert.equal(history.truncated, false);
  assert.ok(history.entries.some((e) => e.action === "UPDATE" && e.previous === original && e.next === corrected));
  const shortHistory = await call(one, "memory_history", { id, limit: 1 });
  assert.equal(shortHistory.entries.length, 1);
  assert.equal(shortHistory.truncated, true);
  assert.equal(shortHistory.entries[0].next, corrected);
  for (const limit of [0, 51, 1.5, "2", null]) {
    await fails(one, "memory_history", { id, limit }, /limit/);
  }
  assert.deepEqual(await call(one, "memory_history", { id }), history, "reads must not append history");
  for (let n = 0; n < 10; n += 1) await call(one, "memory_update", { id, kind: n % 2 ? "fact" : "note" });
  const defaultHistory = await call(one, "memory_history", { id });
  assert.equal(defaultHistory.entries.length, 10);
  assert.equal(defaultHistory.truncated, true);
  const fullHistory = await call(one, "memory_history", { id, limit: 50 });
  assert.equal(fullHistory.entries.length, 15);
  assert.equal(fullHistory.truncated, false);
  const refreshed = await call(one, "memory_search", searchArgs);
  assert.ok(refreshed.results.some((r) => r.id === id && r.text === corrected));
  assert.ok(refreshed.results.every((r) => r.text !== original));
  checks += 1;

  await call(one, "memory_update", { id, expiresAt: "2020-01-01" });
  assert.equal((await call(one, "memory_context")).count, 0);
  await fails(one, "memory_get", { id }, /No memory.*scope/);
  assert.equal((await call(one, "memory_get", { id, includeExpired: true })).text, corrected);
  assert.equal((await call(two, "memory_get", { id, scope: "all", includeExpired: true })).id, id);
  assert.equal((await call(one, "memory_history", { id })).record.expiresAt, "2020-01-01");
  await call(one, "memory_update", { id, expiresAt: null });
  assert.equal((await call(one, "memory_get", { id })).id, id);
  await call(one, "memory_delete", { id });
  await fails(one, "memory_history", { id }, /No memory.*scope/);
  checks += 1;

  // Seventeen UUIDs guarantee a collision in the first hex character. Collision
  // resolution must depend on visibility, never on insertion order.
  const ids = [];
  for (let n = 0; n < 17; n += 1) {
    ids.push((await call(one, "memory_add", { text: `Identifier collision fixture number ${n}.`, force: true })).ids[0]);
  }
  const prefix = ids.find((candidate, i) => ids.some((other, j) => i !== j && other[0] === candidate[0]))[0];
  await fails(one, "memory_get", { id: prefix }, /matches.*use more characters/);
  await fails(two, "memory_get", { id: prefix, scope: "all" }, /matches.*use more characters/);
  await fails(one, "memory_history", { id: prefix }, /matches.*use more characters/);
  await fails(one, "memory_update", { id: prefix, kind: "fact" }, /matches.*use more characters/);
  await fails(two, "memory_get", { id: prefix }, /No memory.*scope/);

  // Old config switches control automatic delivery, not explicit read tools.
  const disabledHome = path.join(root, "disabled-store");
  fs.mkdirSync(disabledHome);
  fs.writeFileSync(path.join(disabledHome, "config.json"), JSON.stringify({
    embedder: { dimension: 384, dimensionModel: model },
    inject: { enabled: false, mcpInstructions: false, includeProtocol: false },
  }));
  const disabled = await connect(path.join(root, "repo-one"), "read-test-user", disabledHome);
  assert.ok(!disabled.getInstructions());
  const explicitContext = await call(disabled, "memory_context");
  assert.equal(explicitContext.count, 0);
  assert.ok(!explicitContext.text.includes("Memory protocol for this session:"));
  // A store can contain searchable facts even though its curated selection is empty.
  const filteredHome = path.join(root, "filtered-store");
  fs.mkdirSync(filteredHome);
  fs.cpSync(cachedModel, path.join(filteredHome, "models", model), { recursive: true });
  fs.writeFileSync(path.join(filteredHome, "config.json"), JSON.stringify({ inject: { kinds: [] } }));
  const filtered = await connect(path.join(root, "repo-one"), "read-test-user", filteredHome);
  const filteredWrite = await call(filtered, "memory_add", { text: original, kind: "fact" });
  const filteredContext = await call(filtered, "memory_context");
  assert.equal(filteredContext.count, 0);
  assert.ok(filteredContext.text.includes("No eligible memories"));
  assert.ok(!filteredContext.text.includes("No memories stored"));
  assert.ok((await call(filtered, "memory_search", searchArgs)).results.some((r) => r.id === filteredWrite.ids[0]));
  const duplicate = await call(filtered, "memory_add", { text: original });
  assert.equal(duplicate.stored, 0);
  assert.ok(!duplicate.note.includes("equivalent memory already exists"));
  // distil requested with LLM disabled stores verbatim, rather than promising extraction.
  const verbatim = await call(filtered, "memory_add", { text: corrected, distil: true, force: true });
  assert.equal(verbatim.stored, 1);
  assert.equal((await call(filtered, "memory_get", { id: verbatim.ids[0] })).text, corrected);

  const brokenHome = path.join(root, "broken-store");
  fs.mkdirSync(brokenHome);
  fs.writeFileSync(path.join(brokenHome, "vectors.db"), "This is not a SQLite database.");
  const broken = await connect(path.join(root, "repo-one"), "read-test-user", brokenHome);
  assert.ok(broken.getInstructions().includes("NOT WORKING"));
  assert.ok(broken.getInstructions().length <= 512);
  await fails(broken, "memory_context", {}, /failed/);
  console.log(`PASS: ${checks} MCP read, history, filtering and isolation checks (real local embeddings; no reranking).`);

  if (process.argv.includes("--compat")) {
    const compatHome = path.join(root, "compat-store");
    fs.cpSync(cachedModel, path.join(compatHome, "models", model), { recursive: true });
    for (const script of ["test-mcp.mjs", "test-cli.mjs", "test-health.mjs"]) {
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], {
          cwd: path.dirname(server),
          stdio: "inherit",
          env: { ...process.env, MEM0_LOCAL_HOME: compatHome, MEM0_LOCAL_USER_ID: "compat-test-user",
            MEM0_LOCAL_NO_LLM: "1", MEM0_LOCAL_NO_RERANK: "1", MEM0_LOCAL_PROBE: "0" },
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code === 0) return resolve();
          const logFile = path.join(compatHome, "logs", "mem0-local.log");
          if (fs.existsSync(logFile)) console.error(fs.readFileSync(logFile, "utf8").split("\n").slice(-15).join("\n"));
          reject(new Error(`${script} exited ${code}`));
        });
      });
    }
  }
} finally {
  await Promise.allSettled(clients.map((client) => client.close()));
  // Only remove the exact directory this invocation created under the OS temp root.
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("mem0-read-test-")) {
    throw new Error(`Refusing cleanup outside the test directory: ${root}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
}
