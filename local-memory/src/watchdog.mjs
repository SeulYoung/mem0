/**
 * Periodic check that the memory layer would actually work if you opened a
 * session right now.
 *
 * The obvious design — alert when the heartbeat goes stale — does not survive
 * contact with reality: the heartbeat only ticks when you start a chat, so a
 * quiet afternoon is indistinguishable from a dead server. This instead *starts
 * the server itself*, exactly the way the IDE would, and sees whether it comes
 * up. No user activity required, and no false alarm from a day off.
 *
 * The subtlety is which node to start it with. The failure we are hunting is an
 * IDE or agent upgrade swapping the runtime underneath a native module, so the
 * check is worthless unless it runs under the same runtime the IDE will use.
 * We therefore probe every JetBrains-bundled agent runtime we can find — which
 * also means a broken upgrade is caught as soon as the IDE ships it, before you
 * open the first chat of the day.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { loadConfig } from "./config.mjs";
import { CURSOR_MCP_FILE, SERVER_KEY, hostFromExecPath, readHeartbeat, readJson, writeJsonAtomic } from "./health.mjs";
import { notify } from "./notify.mjs";
import { PATHS, log } from "./paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(here, "mcp-server.mjs");
const REPO_ROOT = path.resolve(here, "..");

const readdirSafe = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * …/JetBrains/CLion2026.2/acp-agents/cursor/2026.07.23/dist-package/node.exe
 *
 * Only the newest version of each agent is probed: older ones stay on disk
 * after an upgrade and will never be launched again, so failing them would be
 * noise you learn to ignore.
 */
function bundledAgentRuntimes() {
  if (process.platform !== "win32") return [];
  const base = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "JetBrains");
  const found = [];
  for (const ide of readdirSafe(base)) {
    const agentsDir = path.join(base, ide, "acp-agents");
    for (const agent of readdirSafe(agentsDir)) {
      const newest = readdirSafe(path.join(agentsDir, agent)).sort().at(-1);
      if (!newest) continue;
      const executable = path.join(agentsDir, agent, newest, "dist-package", "node.exe");
      if (fs.existsSync(executable)) found.push(executable);
    }
  }
  return found;
}

function runtimesToCheck() {
  const list = [];
  const add = (executable) => {
    if (!executable || !fs.existsSync(executable)) return;
    if (list.some((existing) => samePath(existing, executable))) return;
    list.push(executable);
  };

  // The runtime that served the last real session comes first: if it has since
  // disappeared, that is the upgrade case, and the bundled scan below finds its
  // replacement.
  add(readHeartbeat()?.node);
  for (const executable of bundledAgentRuntimes()) add(executable);
  add(process.execPath);
  return list;
}

/**
 * Start the server the way the IDE does and complete a real MCP handshake.
 * Stderr goes to a file rather than a pipe because the interesting output — a
 * native module refusing to load — arrives before the transport hands us the
 * stream.
 */
export async function probeRuntime(executable, { projectDir = REPO_ROOT, timeoutMs = 90000 } = {}) {
  const started = Date.now();
  const stderrFile = path.join(os.tmpdir(), `mem0-probe-${process.pid}-${Date.now()}.log`);
  const stderrFd = fs.openSync(stderrFile, "w");
  const client = new Client({ name: "mem0-local-watchdog", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: executable,
    args: [SERVER_PATH, "--project-dir", projectDir],
    env: { ...process.env, MEM0_LOCAL_PROBE: "1", MEM0_TELEMETRY: "false" },
    stderr: stderrFd,
  });

  /**
   * A crashing node prints a stack and then its own version banner, so the last
   * line is always the least useful one. The line naming the error is what turns
   * "the server did not start" into "it could not load better_sqlite3.node".
   */
  const readStderr = () => {
    try {
      const lines = fs.readFileSync(stderrFile, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
      const meaningful = lines.find((line) => /error|cannot|failed|not found/i.test(line)) ?? lines.at(-1) ?? "";
      return meaningful.slice(0, 300);
    } catch {
      return "";
    }
  };

  let timer;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no handshake within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      }),
    ]);

    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    if (!tools.includes("memory_search")) throw new Error(`handshake succeeded but memory_search is missing`);

    const instructions = client.getInstructions() ?? "";
    return { ok: true, ms: Date.now() - started, tools: tools.length, instructions };
  } catch (error) {
    const detail = readStderr();
    return { ok: false, ms: Date.now() - started, error: detail ? `${error.message} | ${detail}` : error.message };
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    fs.closeSync(stderrFd);
    fs.rmSync(stderrFile, { force: true });
  }
}

/**
 * Whether this exact problem was already announced recently. Alert fatigue is
 * the failure mode of a monitor: the second popup for a problem you already
 * know about is what teaches you to ignore the first one.
 */
export function isSilenced(previous, signature, repeatHours, now = Date.now()) {
  if (previous?.signature !== signature || !previous?.notifiedAt) return false;
  return now - Date.parse(previous.notifiedAt) < repeatHours * 3600 * 1000;
}

function alertText(problems) {
  const body = problems.slice(0, 2).map((problem) => problem.message);
  if (problems.length > 2) body.push(`(and ${problems.length - 2} more)`);
  body.push("Nothing is being remembered right now. Run: npm run doctor");
  return { title: "mem0-local memory is down", body: body.join("\n") };
}

/**
 * One full check. Returns the verdict so the CLI can print it; alerting is a
 * side effect, suppressed while the same problem keeps repeating so that a
 * broken week does not train you to dismiss the popup.
 */
export async function runWatchdog({ notifications = true, verbose = false } = {}) {
  const config = loadConfig();
  const report = (message) => {
    log("watchdog", message);
    if (verbose) process.stdout.write(`${message}\n`);
  };

  if (config.watchdog?.enabled === false) {
    report("disabled in config, skipping");
    return { status: "disabled", problems: [] };
  }

  const problems = [];
  const checked = [];

  try {
    if (!readJson(CURSOR_MCP_FILE)?.mcpServers?.[SERVER_KEY]) {
      problems.push({
        key: "wiring",
        message: `~/.cursor/mcp.json no longer registers "${SERVER_KEY}", so no IDE will start the memory server`,
      });
    }

    const heartbeat = readHeartbeat();
    const projectDir = heartbeat?.root && fs.existsSync(heartbeat.root) ? heartbeat.root : REPO_ROOT;

    for (const executable of runtimesToCheck()) {
      const label = hostFromExecPath(executable);
      const result = await probeRuntime(executable, {
        projectDir,
        timeoutMs: config.watchdog?.probeTimeoutMs ?? 90000,
      });
      // The instructions themselves are the whole memory list; keep the verdict
      // file to a summary of them.
      checked.push({
        runtime: label,
        executable,
        ok: result.ok,
        ms: result.ms,
        ...(result.ok ? { tools: result.tools, injected: result.instructions.length > 0 } : { error: result.error }),
      });
      report(`probe ${label}: ${result.ok ? `ok in ${result.ms}ms` : `FAILED — ${result.error}`}`);

      if (!result.ok) {
        problems.push({ key: `runtime:${label}`, message: `${label} cannot start the memory server: ${result.error}` });
        continue;
      }
      // The server starts, but told the model it cannot read the store — the
      // degraded case that layer 2 writes into its own instructions.
      if (result.instructions.includes("NOT WORKING")) {
        problems.push({ key: `store:${label}`, message: `${label} starts the server but cannot read the memory store` });
      }
    }
  } catch (error) {
    // A watchdog that dies quietly is worse than no watchdog, so its own
    // failure is a reportable problem like any other.
      problems.push({ key: "watchdog", message: `the watchdog itself failed: ${error.message}` });
  }

  const previous = readJson(PATHS.watchdogFile) ?? {};
  const at = new Date().toISOString();

  if (problems.length === 0) {
    if (previous.signature) report(`recovered from: ${previous.signature}`);
    writeJsonAtomic(PATHS.watchdogFile, { at, status: "ok", checked });
    report(`all ${checked.length} runtime(s) healthy`);
    return { status: "ok", problems, checked };
  }

  const signature = problems.map((problem) => problem.key).sort().join("|");
  const silenced = isSilenced(previous, signature, config.watchdog?.repeatHours ?? 12);

  if (notifications && config.watchdog?.notify !== false && !silenced) {
    await notify(alertText(problems));
  } else if (silenced) {
    report(`same problem as ${previous.notifiedAt}, notification suppressed`);
  }

  writeJsonAtomic(PATHS.watchdogFile, {
    at,
    status: "problem",
    signature,
    problems,
    notifiedAt: silenced ? previous.notifiedAt : at,
    checked,
  });
  report(`problems: ${problems.map((problem) => problem.message).join(" | ")}`);
  return { status: "problem", problems, checked };
}
