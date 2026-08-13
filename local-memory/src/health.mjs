/**
 * Whether the memory layer is still working, and whether the ground underneath
 * it has moved.
 *
 * Two facts shape this file. The failure that costs the most is also the
 * quietest: when the MCP server cannot start, the model just behaves like a
 * model with no memory, which from the outside is indistinguishable from one
 * that searched and found nothing. And the thing most likely to break it is not
 * our code but the runtime beneath it — a JetBrains IDE launches the server
 * with the node it ships, under a path that carries both the IDE and the agent
 * version, while `better-sqlite3` is a native addon compiled for exactly one
 * node ABI.
 *
 * So we record what the environment looked like the last time memory demonstrably
 * worked, and compare against it.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PATHS, ensureDirs } from "./paths.mjs";

export const CURSOR_MCP_FILE = path.join(os.homedir(), ".cursor", "mcp.json");
export const SERVER_KEY = "mem0-local";
/** Names of the Windows scheduled tasks, shared by the installers and `doctor`. */
export const WATCHDOG_TASK = "mem0-local watchdog";
export const SWEEP_TASK = "mem0-local sweep";

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Rename is atomic, so the watchdog never reads a half-written record. */
export function writeJsonAtomic(file, data) {
  ensureDirs();
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

/**
 * The bundled agent runtimes live at a path that spells out who owns them:
 *   …/JetBrains/CLion2026.2/acp-agents/cursor/2026.07.23/dist-package/node.exe
 * Reading the versions off the path is what lets us name the culprit in an
 * alert instead of printing an opaque executable path.
 */
export function hostFromExecPath(execPath) {
  const parts = execPath.split(/[\\/]/);
  const acp = parts.indexOf("acp-agents");
  if (acp > 0 && parts.length > acp + 2) return `${parts[acp - 1]} / ${parts[acp + 1]} ${parts[acp + 2]}`;
  const standalone = parts.indexOf("cursor-agent");
  if (standalone >= 0 && parts.length > standalone + 2) return `cursor-agent ${parts[standalone + 2]}`;
  return "system node";
}

/** Hash our own entry only: another server being added is not our business. */
function mcpEntryHash(file = CURSOR_MCP_FILE) {
  const entry = readJson(file)?.mcpServers?.[SERVER_KEY];
  if (!entry) return "absent";
  return crypto.createHash("sha1").update(JSON.stringify(entry)).digest("hex").slice(0, 12);
}

/** Everything that, when it changes, can silently break the memory layer. */
export function fingerprint({ mcpFile = CURSOR_MCP_FILE } = {}) {
  return {
    node: process.execPath,
    nodeVersion: process.version,
    /**
     * NODE_MODULE_VERSION. `better-sqlite3` is built against exactly one of
     * these, so a bump here is precisely what turns an agent upgrade into a
     * server that dies before it can report anything.
     */
    abi: process.versions.modules,
    host: hostFromExecPath(process.execPath),
    mcpEntry: mcpEntryHash(mcpFile),
  };
}

const LABELS = {
  nodeVersion: "node",
  abi: "node ABI",
  host: "agent runtime",
  mcpEntry: "cursor mcp.json entry",
  node: "node executable",
};

/**
 * Human-readable diff between the environment of the last healthy session and
 * the current one. `node` is deliberately checked last and only when the
 * version and ABI are unchanged, so an IDE upgrade that keeps the same runtime
 * reads as one change rather than two.
 */
export function describeChanges(previous, current) {
  if (!previous) return [];
  const changes = [];
  for (const key of ["nodeVersion", "abi", "host", "mcpEntry"]) {
    if (previous[key] !== undefined && previous[key] !== current[key]) {
      changes.push(`${LABELS[key]}: ${previous[key]} -> ${current[key]}`);
    }
  }
  if (changes.length === 0 && previous.node !== undefined && previous.node !== current.node) {
    changes.push(`${LABELS.node} moved: ${previous.node} -> ${current.node}`);
  }
  return changes;
}

export function readHeartbeat(file = PATHS.heartbeatFile) {
  return readJson(file);
}

/**
 * Written when a server finishes starting up. `ok` records whether that server
 * could actually read the store, which is what makes the heartbeat evidence of
 * working memory rather than merely of a process that launched.
 */
export function writeHeartbeat(details, file = PATHS.heartbeatFile) {
  const record = { at: new Date().toISOString(), pid: process.pid, ...fingerprint(), ...details };
  try {
    writeJsonAtomic(file, record);
  } catch {
    // A heartbeat that cannot be written must never take the session down.
  }
  return record;
}

export function recordToolFailure(tool, message, file = PATHS.toolErrorFile) {
  try {
    writeJsonAtomic(file, { at: new Date().toISOString(), tool, message });
  } catch {
    // best effort
  }
}

export function readToolFailure(file = PATHS.toolErrorFile) {
  return readJson(file);
}

export function ageMinutes(isoTimestamp) {
  const parsed = Date.parse(isoTimestamp ?? "");
  return Number.isNaN(parsed) ? null : Math.round((Date.now() - parsed) / 60000);
}

export function formatAge(isoTimestamp) {
  const minutes = ageMinutes(isoTimestamp);
  if (minutes === null) return "never";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}
