#!/usr/bin/env node
/**
 * Local-only MCP server over stdio. Exposes the memory store in ~/.mem0-local
 * as tools the agent can call directly. Nothing leaves the machine.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { ensureConfigFile } from "./config.mjs";
import { describeChanges, fingerprint, readHeartbeat, recordToolFailure, writeHeartbeat } from "./health.mjs";
import { flushStaleTurns } from "./hooks/_turn-store.mjs";
import { buildInjectionText, MCP_INSTRUCTIONS } from "./injection.mjs";
import { isNestedAgentInvocation, isNestedAgentWorkspace } from "./llm.mjs";
import {
  addMemory,
  deleteMemory,
  getMemory,
  historyMemory,
  listMemories,
  queryReachWarning,
  routeConsoleToStderr,
  searchMemories,
  statsMemories,
  updateMemory,
} from "./memory.mjs";
import { log } from "./paths.mjs";
import { resolveProject } from "./project.mjs";
import { memoryTools } from "./tools.mjs";

routeConsoleToStderr();

function projectDirFromArgv() {
  const index = process.argv.indexOf("--project-dir");
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  // Cursor leaves ${workspaceFolder} untouched when there is no workspace.
  return value && !value.startsWith("${") ? value : undefined;
}

const projectDir = projectDirFromArgv();
const currentProject = () => resolveProject(projectDir);

// The summarisation model runs as a nested Cursor agent that inherits this MCP
// wiring. It has one job and no use for memory tools, so do not serve it.
if (isNestedAgentInvocation() || isNestedAgentWorkspace(currentProject().root)) {
  log("mcp", "declining to serve a nested summarisation agent");
  process.exit(0);
}

const config = ensureConfigFile();

// Every word of this lives in `tools.mjs`: the schemas are prompt text, and the
// drift test has to be able to read them without starting a server.
const TOOLS = memoryTools(config);

async function runTool(name, args) {
  const project = currentProject();

  switch (name) {
    case "memory_context": {
      const built = await buildInjectionText({ project, config });
      return { project: project.id, ...built };
    }
    case "memory_search": {
      const results = await searchMemories({
        query: args.query,
        project,
        topK: args.topK ?? null,
        scope: args.scope ?? "project",
        kind: args.kind ?? null,
        explain: args.explain === true,
      });
      // Ahead of the results rather than beside them: an agent that reads the
      // hits first has already started trusting an arbitrary ordering.
      const warning = queryReachWarning(args.query);
      return { project: project.id, ...(warning ? { warning } : {}), count: results.length, results };
    }
    case "memory_get":
      return getMemory({
        id: args.id,
        project,
        scope: args.scope ?? "project",
        includeExpired: args.includeExpired ?? false,
      });
    case "memory_history":
      return historyMemory({ id: args.id, project, limit: args.limit === undefined ? 10 : args.limit });
    case "memory_add": {
      const stored = await addMemory({
        text: args.text,
        project,
        kind: args.kind ?? "note",
        source: "mcp",
        evidence: args.evidence ?? undefined,
        confidenceReason: args.confidenceReason ?? null,
        verifiedAt: args.verifiedAt ?? null,
        infer: args.distil === true,
        expiresAt: args.expiresAt ?? null,
        dedupe: args.force !== true,
      });
      return {
        stored: stored.length,
        ids: stored.map((record) => record.id),
        project: project.id,
        // No rows does not identify the cause: dedupe or extraction can yield none.
        ...(stored.length === 0 ? { note: "Nothing stored: the input may be a duplicate, or extraction produced no new memories." } : {}),
      };
    }
    case "memory_list": {
      const results = await listMemories({
        project,
        limit: args.limit ?? 10,
        scope: args.scope ?? "project",
        includeExpired: args.includeExpired === true,
      });
      return { project: project.id, count: results.length, results };
    }
    case "memory_update":
      return updateMemory({
        id: args.id,
        text: args.text,
        kind: args.kind,
        evidence: args.evidence,
        confidenceReason: args.confidenceReason,
        verifiedAt: args.verifiedAt,
        expiresAt: args.expiresAt,
        project,
      });
    case "memory_delete":
      return deleteMemory(args.id, project);
    case "memory_stats":
      return statsMemories();
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * When the store is unreadable the session is silently useless: a model with no
 * memories behaves exactly like a model that searched and found nothing, so
 * nobody notices. The instructions are the one channel that reaches the user in
 * that state, so spend them on saying so.
 */
function degradedInstructions(error) {
  return [
    "Local memory — NOT WORKING. Tell the user the store could not be read at startup.",
    `Reason: ${String(error.message).replace(/\s+/g, " ").slice(0, 140)}`,
    'Run the adapter CLI "doctor" command; details are in the mem0-local log.',
    "Do not use memory tools until the store is repaired, then reconnect.",
  ].join("\n");
}

/**
 * Builds the session's instructions and records what happened, which doubles as
 * the heartbeat the watchdog reads. Both jobs need the same one attempt at the
 * store, so they live together.
 */
async function startUp() {
  const project = currentProject();
  const changes = describeChanges(readHeartbeat(), fingerprint());
  if (changes.length > 0) log("mcp", `environment changed since the last session: ${changes.join("; ")}`);

  const wanted = config.inject.enabled && config.inject.mcpInstructions !== false;
  let instructions;
  let store = "unchecked";
  const memories = null; // Startup checks storage; it no longer delivers memories.

  if (wanted) {
    try {
      // Preserve startup health detection without publishing or caching memory
      // contents. Actual context is rendered fresh when the tool is called.
      await listMemories({ project, limit: 1, scope: "project" });
      instructions = MCP_INSTRUCTIONS;
      store = "ok";
      log("mcp", "store readable; short instructions ready (context is on demand)");
    } catch (error) {
      instructions = degradedInstructions(error);
      store = "failed";
      log("mcp", `store unreadable at startup, warning the model instead: ${error.message}`);
    }
  }

  // A probe run is not evidence that anything real happened, so it must not
  // leave a heartbeat behind for the watchdog to trust — nor write memories.
  if (process.env.MEM0_LOCAL_PROBE !== "1") {
    writeHeartbeat({ project: project.id, root: project.root, store, memories, changes });
    // Turns whose `stop` never arrived. `sessionStart` does this too, but that
    // hook only runs in Cursor: without this line a turn parked in Cursor and
    // then abandoned would wait for the next Cursor session, however long you
    // spend in an ACP host. Every host starts this server, so this is the one
    // claim path that is host-independent.
    try {
      const stale = flushStaleTurns((config.capture?.turnTimeoutMinutes ?? 120) * 60 * 1000);
      if (stale > 0) log("mcp", `flushed ${stale} unfinished turn(s)`);
    } catch (error) {
      log("mcp", `could not flush unfinished turns: ${error.message}`);
    }
  }

  return instructions;
}

const server = new Server(
  { name: "mem0-local", version: "0.1.0" },
  { capabilities: { tools: {} }, instructions: await startUp() },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    const result = await runTool(name, args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    log("mcp", `tool ${name} failed: ${error.stack ?? error.message}`);
    // Kept for `doctor` to show. The watchdog deliberately ignores it: most tool
    // errors are ordinary ("no memory with that id") and would only teach you to
    // dismiss the alerts that matter.
    recordToolFailure(name, error.message);
    return { content: [{ type: "text", text: `Memory tool "${name}" failed: ${error.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
// The root is worth logging: ACP hosts never expand `${workspaceFolder}`, so
// which repository a session belongs to is decided by the working directory the
// host gave us, and a surprise there is otherwise invisible.
log("mcp", `server ready (project=${currentProject().id} root=${currentProject().root})`);
