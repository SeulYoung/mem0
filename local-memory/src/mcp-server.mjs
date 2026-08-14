#!/usr/bin/env node
/**
 * Local-only MCP server over stdio. Exposes the memory store in ~/.mem0-local
 * as tools the agent can call directly. Nothing leaves the machine.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { ensureConfigFile } from "./config.mjs";
import { describeChanges, fingerprint, readHeartbeat, recordToolFailure, writeHeartbeat } from "./health.mjs";
import { flushStaleTurns } from "./hooks/_turn-store.mjs";
import { buildInjectionText } from "./injection.mjs";
import { isNestedAgentInvocation, isNestedAgentWorkspace } from "./llm.mjs";
import {
  KINDS,
  KIND_GUIDE,
  addMemory,
  deleteMemory,
  listMemories,
  routeConsoleToStderr,
  searchMemories,
  statsMemories,
  updateMemory,
} from "./memory.mjs";
import { log } from "./paths.mjs";
import { resolveProject } from "./project.mjs";

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

const SCOPE_READ = {
  type: "string",
  enum: ["project", "all"],
  description: 'Search this repository ("project", default) or every repository ("all").',
};

/**
 * The catalog plus the two calls that actually get made wrong. Both overlaps
 * were found by reading what earlier sessions stored: pure measurements filed as
 * `gotcha`, and this layer's own choices filed as `fact`. The last line exists
 * because "will do X" and "X is done now" were being stored as memories, and a
 * memory that describes work in flight is wrong within the week.
 */
const KIND_DESCRIPTION = [
  "Which category the memory belongs to (default \"note\"):",
  ...Object.entries(KIND_GUIDE).map(([kind, test]) => `- ${kind}: ${test}`),
  "If it fits both fact and gotcha, ask whether something goes wrong when you do not know it, and whether it goes wrong quietly — a constraint that fails loudly on the first try is a fact, not a gotcha.",
  "If it fits both convention and decision, what you have to follow is a convention; what explains why things look the way they do is a decision.",
  "Never store a progress report: \"X is now done\" stops being true and reads as news forever. Write the durable fact the work left behind.",
  "Storing something not yet built — a design you worked out, a step you agreed — needs an expiresAt, because nothing else in this store ever removes it.",
].join("\n");

const MEMORY_ID = {
  type: "string",
  description:
    "Memory id from memory_search, memory_list, or the list injected at the start of this session. The shortened eight-character form shown there is enough. Must name a memory belonging to this repository — memories owned by another repository are readable with scope \"all\" but can only be changed from the repository that owns them.",
};

const TOOLS = [
  {
    name: "memory_search",
    description:
      "Search the local memory store for things learned in earlier sessions (user preferences, project conventions, past decisions, gotchas). Call this before answering questions that depend on prior context, and whenever the user refers to something previously discussed.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural-language description of what you are looking for, in English — memories are stored in English and retrieval is English-only, so translate the user's wording rather than passing it through. Keep identifiers, file names and command names exactly as they appear: they are what the keyword and entity signals match on.",
        },
        topK: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: `How many memories to return (default ${config.search.topK}). Raise it when the first answer looks incomplete; the results are ordered, so the extra ones are weaker matches rather than more of the same.`,
        },
        scope: SCOPE_READ,
      },
      required: ["query"],
    },
  },
  {
    name: "memory_add",
    description:
      "Store one durable, self-contained fact worth remembering in future sessions: a user preference, a project convention, an architectural decision and its reason, or a non-obvious pitfall. Write it as one statement of 15-80 words that will still make sense months later without this conversation. Do not store transient task state, secrets, or anything already obvious from the code.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            "The memory, as one self-contained English statement, opening with the topic it is about. Write English even when the conversation is in another language: retrieval is English-only, and a memory in another language is close to unreachable. Keep identifiers, file names, paths and command names exactly as they appear in the source.",
        },
        kind: { type: "string", enum: KINDS, description: KIND_DESCRIPTION },
        distil: {
          type: "boolean",
          description:
            "Default false, which stores your text as written — normally the right choice, since you are already writing one clean fact. Set true only to hand a longer, messy passage to the summarisation model, which will split it into facts and drop anything already stored. Costs about 15 seconds.",
        },
        expiresAt: {
          type: "string",
          description:
            'Date after which this memory is ignored, as "YYYY-MM-DD". Set it when the fact has a known shelf life — a measured duration, a dependency version, a workaround for a bug that will be fixed. Leave it out for anything that should be remembered indefinitely.',
        },
        force: {
          type: "boolean",
          description:
            "Store the memory even though an existing one already says nearly the same thing. Only use this after a rejection told you which memory it collided with and you decided the two really are different facts; the normal response to that rejection is memory_update on the memory named in it.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "memory_list",
    description: "List the most recently stored memories, newest first. Useful for reviewing or cleaning up what was captured.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 50, description: "How many to return (default 10)." },
        scope: SCOPE_READ,
        includeExpired: {
          type: "boolean",
          description:
            "Also list memories whose expiry date has passed. They are hidden everywhere else, so this is the only way to find one and revive it with memory_update.",
        },
      },
    },
  },
  {
    name: "memory_update",
    description:
      "Rewrite a memory that has turned out to be wrong or has drifted out of date, keeping its id and its original date. Prefer this over deleting and adding: memories are never overwritten automatically, so a corrected fact added as a new memory just sits alongside the stale one and both come back in future searches. Also use it to put an expiry date on a fact with a known shelf life — once that date passes the memory stops appearing in searches and in the next session's context.",
    inputSchema: {
      type: "object",
      properties: {
        id: MEMORY_ID,
        text: {
          type: "string",
          description:
            "The corrected memory, written the way memory_add wants it: one self-contained English sentence opening with the topic. State the fact as it is now — do not describe the correction.",
        },
        // Pointer rather than a second copy: both tools are listed together in
        // every session, and the catalog is not short.
        kind: {
          type: "string",
          enum: KINDS,
          description: "Move the memory to a different category, judged by the same tests memory_add lists.",
        },
        expiresAt: {
          type: ["string", "null"],
          description:
            'Date after which this memory is ignored, as "YYYY-MM-DD". Use it for facts with a known shelf life, such as a measured duration or a dependency version. Pass null to remove an expiry that was set earlier.',
        },
      },
      required: ["id"],
    },
  },
  {
    name: "memory_delete",
    description:
      "Delete one memory by id. Use it when a remembered fact should simply be gone; if it is merely wrong or outdated, memory_update keeps the history instead.",
    inputSchema: { type: "object", properties: { id: MEMORY_ID }, required: ["id"] },
  },
  {
    name: "memory_stats",
    description: "Report how many memories are stored, split by repository and category, plus where the data lives on disk.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function runTool(name, args) {
  const project = currentProject();

  switch (name) {
    case "memory_search": {
      const results = await searchMemories({
        query: args.query,
        project,
        topK: args.topK ?? null,
        scope: args.scope ?? "project",
      });
      return { project: project.id, count: results.length, results };
    }
    case "memory_add": {
      const stored = await addMemory({
        text: args.text,
        project,
        kind: args.kind ?? "note",
        source: "mcp",
        infer: args.distil === true,
        expiresAt: args.expiresAt ?? null,
        dedupe: args.force !== true,
      });
      return {
        stored: stored.length,
        ids: stored.map((record) => record.id),
        project: project.id,
        // 0 with distil means the model judged it already covered by an existing memory.
        ...(stored.length === 0 ? { note: "Nothing stored — an equivalent memory already exists." } : {}),
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

const CLI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.mjs");

/**
 * When the store is unreadable the session is silently useless: a model with no
 * memories behaves exactly like a model that searched and found nothing, so
 * nobody notices. The instructions are the one channel that reaches the user in
 * that state, so spend them on saying so.
 */
function degradedInstructions(error, changes) {
  return [
    "## Local memory (mem0-local) — NOT WORKING",
    "",
    `The memory store could not be read when this session started: ${error.message}`,
    "Nothing is being remembered or recalled right now.",
    ...(changes.length > 0 ? ["", "The environment changed since memory last worked:", ...changes.map((c) => `- ${c}`)] : []),
    "",
    "Open your first reply with one short line telling the user that mem0-local is down and why,",
    `then point them at: node "${CLI_PATH}" doctor`,
    "",
    // Deliberately not the usual protocol: telling an agent to search and store
    // when the store is unreadable buys a run of failing tool calls, and it
    // contradicts the paragraph above in the same breath.
    "Do not call the memory tools until that is fixed — they read the same store and will fail.",
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
  let memories = null;

  if (wanted) {
    try {
      const built = await buildInjectionText({ project, config });
      instructions = built.text;
      memories = built.count;
      store = "ok";
      log("mcp", `instructions built (memories=${built.count})`);
    } catch (error) {
      instructions = degradedInstructions(error, changes);
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
