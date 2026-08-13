#!/usr/bin/env node
/**
 * Connects to the local MCP server the same way Cursor does (stdio + real MCP
 * handshake) and exercises every tool. Run after changing mcp-server.mjs.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "src", "mcp-server.mjs");
const projectDir = process.argv[2] ?? path.join(here, "..");

async function connect() {
  const client = new Client({ name: "mem0-local-test", version: "0.1.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverPath, "--project-dir", projectDir],
      stderr: "inherit",
    }),
  );
  return client;
}

const client = await connect();

const show = (label, value) => process.stdout.write(`\n== ${label}\n${JSON.stringify(value, null, 2)}\n`);
const call = async (name, args = {}) => {
  const response = await client.callTool({ name, arguments: args });
  const text = response.content?.[0]?.text ?? "";
  if (response.isError) throw new Error(`${name} returned an error: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

show("tools", (await client.listTools()).tools.map((tool) => tool.name));

// The second injection channel: hosts that never run Cursor hooks (every ACP
// client) see the memories only if they arrive with the handshake.
const instructions = client.getInstructions();
show("instructions", instructions);
if (!instructions?.includes("## Local memory (mem0-local)")) {
  throw new Error("the server handshake carried no memory injection");
}
if (!instructions.includes("memory_search")) throw new Error("the memory protocol is missing from the instructions");

const FIXTURE = "MCP 自检记忆：这个仓库的本地记忆层放在 local-memory 目录，不改动上游文件。";

/**
 * A run that died before its teardown would otherwise poison the next one.
 * Expired records are included because this test sets an expiry, and an expired
 * leftover is invisible to every other listing.
 */
async function purge() {
  const removed = [];
  for (const record of (await call("memory_list", { limit: 50, includeExpired: true })).results ?? []) {
    if (!record.text.includes("MCP 自检记忆")) continue;
    await call("memory_delete", { id: record.id });
    removed.push(record.id);
  }
  return removed;
}

show("purged leftovers", await purge());

const added = await call("memory_add", { text: FIXTURE, kind: "convention" });
show("memory_add", added);
if (added.stored !== 1) throw new Error(`memory_add stored ${added.stored} records, expected 1`);

// mem0 compares content hashes only on its extraction path; the verbatim path
// this tool uses by default has no such check, so the duplicate guard has to
// come from this layer.
const readded = await call("memory_add", { text: FIXTURE, kind: "convention" });
show("memory_add (identical text again)", readded);
if (readded.stored !== 0) throw new Error("re-adding an identical memory stored a second copy");
if (!readded.note) throw new Error("a skipped duplicate must say so in the tool result");

// Built per session rather than baked in, so a memory stored now is there for
// the next one.
const laterClient = await connect();
const laterInstructions = laterClient.getInstructions() ?? "";
await laterClient.close();
show("instructions carry the new memory", laterInstructions.includes("local-memory 目录"));
if (!laterInstructions.includes("local-memory 目录")) {
  throw new Error("instructions are stale: a memory stored before the handshake was not injected");
}

// --- memory_update -----------------------------------------------------------
const before = (await call("memory_list", { limit: 50 })).results.find((record) => record.id === added.ids[0]);
// The eight characters the injection and the CLI print are all an agent normally
// has; requiring the full uuid would mean a search before every correction.
const shortId = added.ids[0].slice(0, 8);
const CORRECTED = "MCP 自检记忆：本地记忆层放在 local-memory 目录，提示词通过 stdin 交给模型。";

const updated = await call("memory_update", { id: shortId, text: CORRECTED, kind: "decision" });
show("memory_update (addressed by shortened id)", updated);
if (updated.id !== added.ids[0]) throw new Error("an update must keep the memory id");
if (updated.text !== CORRECTED) throw new Error("the corrected text was not stored");
if (updated.kind !== "decision") throw new Error("the new kind was not applied");
if (updated.createdAt !== before.createdAt) throw new Error("an update must preserve the original createdAt");
if (updated.project !== before.project) throw new Error("an update must not drop the project metadata");

// The hash guard matches on the input, so it has to follow the edit: the
// corrected text is now the one that is turned away silently.
if ((await call("memory_add", { text: CORRECTED, kind: "decision" })).stored !== 0) {
  throw new Error("the duplicate guard did not follow the corrected text");
}

// The text that was replaced no longer matches any hash, so nothing silent
// stands in its way — but it still says what the correction says, and that is
// caught out loud, naming the memory it collided with.
const collision = await client.callTool({ name: "memory_add", arguments: { text: FIXTURE, kind: "convention" } });
const collisionText = collision.content?.[0]?.text ?? "";
show("memory_add (a text that means what an existing memory means)", collisionText);
if (!collision.isError) throw new Error("a near-duplicate was stored as a second copy");
if (!collisionText.includes(shortId)) {
  throw new Error("the rejection must name the memory it collided with, or the agent cannot act on it");
}

// And `force` is the way past it, for when the two really are different facts.
const forced = await call("memory_add", { text: FIXTURE, kind: "convention", force: true });
if (forced.stored !== 1) throw new Error("force did not store the memory");
await call("memory_delete", { id: forced.ids[0] });

// An expiry can be set at write time, not only by a later correction.
const shortLived = await call("memory_add", {
  text: "MCP 自检记忆：这条记忆带着已经过期的日期写入，只用来验证写入时的有效期。",
  kind: "note",
  expiresAt: "2020-01-01",
});
show("memory_add (with an expiry already in the past)", shortLived);
if (shortLived.stored !== 1) throw new Error("a memory with an expiry was not stored");
if ((await call("memory_list", { limit: 50 })).results.some((record) => record.id === shortLived.ids[0])) {
  throw new Error("a memory written with a past expiry must not be listed");
}
if (!(await call("memory_list", { limit: 50, includeExpired: true })).results.some((r) => r.id === shortLived.ids[0])) {
  throw new Error("includeExpired must still find it");
}
await call("memory_delete", { id: shortLived.ids[0] });

const missing = await client.callTool({ name: "memory_update", arguments: { id: "zzzzzzzz", text: "x" } });
if (!missing.isError) throw new Error("an id that matches nothing must be reported as an error, not ignored");

// Re-adding under the other scope would mint a new id and a new date, which is
// exactly what the injected list is keyed on.
const promoted = await call("memory_update", { id: shortId, scope: "global" });
show("memory_update (moved to global scope)", { id: promoted.id, project: promoted.project });
if (promoted.project !== "global") throw new Error("the memory was not moved to global scope");
if (promoted.id !== added.ids[0] || promoted.createdAt !== before.createdAt) {
  throw new Error("moving scope must keep the id and the original date");
}
const demoted = await call("memory_update", { id: shortId, scope: "project" });
if (demoted.project !== before.project) throw new Error("the memory did not come back to this repository");

// --- expiry ------------------------------------------------------------------
const expired = await call("memory_update", { id: shortId, expiresAt: "2020-01-01" });
show("memory_update (expiry in the past)", expired);
if (expired.expiresAt !== "2020-01-01") throw new Error("the expiry date was not recorded");
if ((await call("memory_list", { limit: 50 })).results.some((record) => record.id === added.ids[0])) {
  throw new Error("an expired memory must drop out of the listing");
}

const afterExpiry = await connect();
const expiredInstructions = afterExpiry.getInstructions() ?? "";
await afterExpiry.close();
if (expiredInstructions.includes("MCP 自检记忆")) {
  throw new Error("an expired memory must not be injected into the next session");
}

// Addressed by the full id on purpose: an expired memory is invisible to the
// listing that resolves shortened ids, which is the point of expiring it.
const revived = await call("memory_update", { id: added.ids[0], expiresAt: null });
show("memory_update (expiry cleared)", revived);
if (revived.expiresAt) throw new Error("expiresAt: null must clear the expiry");
if (!(await call("memory_list", { limit: 50 })).results.some((record) => record.id === added.ids[0])) {
  throw new Error("clearing the expiry must bring the memory back");
}

show("memory_search", await call("memory_search", { query: "本地记忆层放在哪里", topK: 3 }));
show("memory_list", await call("memory_list", { limit: 3 }));
show("memory_stats", await call("memory_stats"));

for (const id of added.ids ?? []) show("memory_delete", await call("memory_delete", { id }));

await client.close();
process.stdout.write("\nMCP test finished.\n");
