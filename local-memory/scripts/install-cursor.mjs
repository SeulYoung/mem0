#!/usr/bin/env node
/**
 * Registers the local memory layer with Cursor at the user level, so every
 * project gets it without per-repository setup:
 *
 *   ~/.cursor/mcp.json    -> the mem0-local MCP server (agent-driven read/write)
 *   ~/.cursor/hooks.json  -> sessionStart injection + beforeSubmitPrompt capture
 *
 * Both files are merged, not overwritten: existing servers and hooks are kept,
 * a timestamped backup is written, and re-running changes nothing. Pass
 * --uninstall to remove only the entries this script owns.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_KEY = "mem0-local";
/** Marker used to recognise our own hook entries on re-install/uninstall. */
const MARKER = "local-memory/src/hooks";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
/** Forward slashes keep the JSON readable and work fine for node on Windows. */
const posix = (...parts) => path.join(root, ...parts).split(path.sep).join("/");

const cursorDir = path.join(os.homedir(), ".cursor");
const mcpFile = path.join(cursorDir, "mcp.json");
const hooksFile = path.join(cursorDir, "hooks.json");
const uninstall = process.argv.includes("--uninstall");

const log = (message) => process.stdout.write(`${message}\n`);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`${file} is not valid JSON — fix or move it first (${error.message})`);
    }
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  }
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function updateMcp() {
  const config = readJson(mcpFile, { mcpServers: {} });
  config.mcpServers ??= {};

  if (uninstall) {
    if (!(SERVER_KEY in config.mcpServers)) return log(`mcp.json: no "${SERVER_KEY}" entry, nothing to remove`);
    delete config.mcpServers[SERVER_KEY];
    writeJson(mcpFile, config);
    return log(`mcp.json: removed "${SERVER_KEY}"`);
  }

  const desired = {
    command: "node",
    args: [posix("src", "mcp-server.mjs"), "--project-dir", "${workspaceFolder}"],
    env: { MEM0_TELEMETRY: "false" },
  };

  if (JSON.stringify(config.mcpServers[SERVER_KEY]) === JSON.stringify(desired)) {
    return log(`mcp.json: "${SERVER_KEY}" already up to date`);
  }
  config.mcpServers[SERVER_KEY] = desired;
  writeJson(mcpFile, config);
  log(`mcp.json: registered "${SERVER_KEY}"`);
}

function updateHooks() {
  const config = readJson(hooksFile, { version: 1, hooks: {} });
  config.version ??= 1;
  config.hooks ??= {};

  const desired = {
    sessionStart: { command: `node "${posix("src", "hooks", "session-start.mjs")}"`, timeout: 10 },
    beforeSubmitPrompt: { command: `node "${posix("src", "hooks", "before-submit-prompt.mjs")}"`, timeout: 8 },
  };

  let changed = false;
  for (const [event, entry] of Object.entries(desired)) {
    const existing = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    const others = existing.filter((item) => !String(item?.command ?? "").includes(MARKER));

    if (uninstall) {
      if (others.length === existing.length) continue;
      changed = true;
      if (others.length > 0) config.hooks[event] = others;
      else delete config.hooks[event];
      continue;
    }

    const next = [...others, entry];
    if (JSON.stringify(config.hooks[event]) !== JSON.stringify(next)) {
      config.hooks[event] = next;
      changed = true;
    }
  }

  if (!changed) return log(`hooks.json: already ${uninstall ? "clean" : "up to date"}`);
  writeJson(hooksFile, config);
  log(`hooks.json: ${uninstall ? "removed" : "registered"} sessionStart + beforeSubmitPrompt`);
}

updateMcp();
updateHooks();

log("");
if (uninstall) {
  log("Removed the Cursor wiring. Memories in ~/.mem0-local are untouched.");
} else {
  log("Done. Restart Cursor (or reload the window) so it picks up both files.");
  log("Verify with: Cursor Settings -> MCP (mem0-local tools) and Customize -> Hooks.");
}
