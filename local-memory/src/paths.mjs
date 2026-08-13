import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * All runtime state lives outside this repository so that re-downloading or
 * replacing the mem0 checkout never touches your memories.
 * Override with MEM0_LOCAL_HOME if you want the data somewhere else.
 */
export const HOME = process.env.MEM0_LOCAL_HOME
  ? path.resolve(process.env.MEM0_LOCAL_HOME)
  : path.join(os.homedir(), ".mem0-local");

export const PATHS = {
  home: HOME,
  configFile: path.join(HOME, "config.json"),
  vectorDb: path.join(HOME, "vectors.db"),
  historyDb: path.join(HOME, "history.db"),
  historyDir: path.join(HOME, "history"),
  modelCache: path.join(HOME, "models"),
  /**
   * The reranker's model, kept apart because a different library downloads it:
   * transformers.js owns this tree and lays it out as `<org>/<model>/`, while
   * fastembed owns the flat folders next to it.
   */
  rerankerCache: path.join(HOME, "models", "transformers"),
  queueDir: path.join(HOME, "queue"),
  logDir: path.join(HOME, "logs"),
  logFile: path.join(HOME, "logs", "mem0-local.log"),
  /**
   * Health state lives in three separate files rather than one, because three
   * different processes write it: any MCP server writes the heartbeat, the
   * watchdog writes its own verdict, and a failing tool call writes the last
   * error. Separate files mean none of them ever has to read-modify-write a
   * file another process is holding.
   */
  heartbeatFile: path.join(HOME, "heartbeat.json"),
  watchdogFile: path.join(HOME, "watchdog.json"),
  toolErrorFile: path.join(HOME, "last-tool-error.json"),
  /** What the last sweep of expired memories deleted, for `doctor` to report. */
  sweepFile: path.join(HOME, "last-sweep.json"),
};

export function ensureDirs() {
  for (const dir of [PATHS.home, PATHS.historyDir, PATHS.modelCache, PATHS.queueDir, PATHS.logDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const MAX_LOG_BYTES = 2 * 1024 * 1024;

/** Append a line to the local log. Never throws — logging must not break a hook. */
export function log(scope, message, extra) {
  try {
    ensureDirs();
    try {
      if (fs.statSync(PATHS.logFile).size > MAX_LOG_BYTES) {
        fs.renameSync(PATHS.logFile, `${PATHS.logFile}.1`);
      }
    } catch {
      // no existing log file
    }
    const parts = [new Date().toISOString(), `[${scope}]`, message];
    if (extra !== undefined) parts.push(typeof extra === "string" ? extra : JSON.stringify(extra));
    fs.appendFileSync(PATHS.logFile, `${parts.join(" ")}\n`);
  } catch {
    // ignore
  }
}
