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

async function connect(directory, user = "read-test-user") {
  fs.mkdirSync(directory, { recursive: true });
  const client = new Client({ name: "read-test", version: "1.0.0" });
  clients.push(client);
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [server, "--project-dir", directory],
    stderr: "pipe",
    env: { ...process.env, MEM0_LOCAL_HOME: path.join(root, "store"), MEM0_LOCAL_USER_ID: user,
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
  for (const name of ["memory_get", "memory_history"]) {
    assert.equal(catalog.find((t) => t.name === name)?.annotations?.readOnlyHint, true, name);
  }
  assert.ok(one.getInstructions().includes("without kind"));
  checks += 1;

  const original = "dsdebug constructs dedicated server launch arguments in tools/dsdebug/server/task_manager.py::_build_argv and appends -StressTest.";
  const added = await call(one, "memory_add", { text: original, kind: "fact" });
  const id = added.ids[0];
  assert.equal(added.stored, 1);
  const record = await call(one, "memory_get", { id: id.slice(0, 8).toUpperCase() });
  assert.equal(record.id, id);
  assert.equal(record.text, original);
  assert.equal((await call(one, "memory_get", { id })).id, id);
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
  assert.equal(fullHistory.entries.length, 12);
  assert.equal(fullHistory.truncated, false);
  const refreshed = await call(one, "memory_search", searchArgs);
  assert.ok(refreshed.results.some((r) => r.id === id && r.text === corrected));
  assert.ok(refreshed.results.every((r) => r.text !== original));
  checks += 1;

  await call(one, "memory_update", { id, expiresAt: "2020-01-01" });
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
  console.log(`PASS: ${checks} MCP read, history, filtering and isolation checks (real local embeddings; no reranking).`);

  if (process.argv.includes("--compat")) {
    const compatHome = path.join(root, "compat-store");
    fs.cpSync(cachedModel, path.join(compatHome, "models", model), { recursive: true });
    for (const script of ["test-mcp.mjs", "test-cli.mjs"]) {
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
