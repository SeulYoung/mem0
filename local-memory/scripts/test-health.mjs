#!/usr/bin/env node
/**
 * Covers the two things that make failure visible: the fingerprint that
 * recognises a changed runtime, and the probe that starts the memory server the
 * way an IDE would. Run after changing health.mjs, watchdog.mjs or notify.mjs.
 *
 *   node scripts/test-health.mjs [--notify]
 *
 * --notify also fires one real desktop notification, which is the only way to
 * find out whether the toast actually reaches your screen.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describeChanges, fingerprint, formatAge, hostFromExecPath, readHeartbeat, writeHeartbeat } from "../src/health.mjs";
import { isSilenced, probeRuntime } from "../src/watchdog.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

let passed = 0;
const check = (label, condition, detail = "") => {
  if (!condition) throw new Error(`FAILED: ${label}${detail ? ` — ${detail}` : ""}`);
  passed += 1;
  process.stdout.write(`  ok  ${label}${detail ? `  (${detail})` : ""}\n`);
};

process.stdout.write("\n== fingerprint\n");
const current = fingerprint();
check("names the running node", current.nodeVersion === process.version, current.nodeVersion);
check("records the native ABI", /^\d+$/.test(current.abi), `ABI ${current.abi}`);
check("identifies the host runtime", typeof current.host === "string" && current.host.length > 0, current.host);
check("hashes our own mcp.json entry", typeof current.mcpEntry === "string", current.mcpEntry);

process.stdout.write("\n== reading versions off a bundled runtime path\n");
check(
  "JetBrains layout",
  hostFromExecPath("C:\\Users\\me\\AppData\\Local\\JetBrains\\CLion2026.2\\acp-agents\\cursor\\2026.07.23\\dist-package\\node.exe") ===
    "CLion2026.2 / cursor 2026.07.23",
);
check("a plain install is not mistaken for one", hostFromExecPath("C:\\Program Files\\nodejs\\node.exe") === "system node");

process.stdout.write("\n== change detection\n");
check("an unchanged environment is quiet", describeChanges(current, current).length === 0);
const abiBump = describeChanges({ ...current, abi: "115", nodeVersion: "v20.11.0" }, current);
check("an ABI bump is reported", abiBump.some((line) => line.startsWith("node ABI")), abiBump.join("; "));
check(
  "losing the mcp.json entry is reported",
  describeChanges({ ...current, mcpEntry: "absent" }, current).some((line) => line.includes("mcp.json")),
);
check(
  "a moved executable alone still reports once",
  describeChanges({ ...current, node: "C:\\elsewhere\\node.exe" }, current).length === 1,
);

process.stdout.write("\n== heartbeat round trip\n");
const heartbeatFile = path.join(os.tmpdir(), `mem0-heartbeat-test-${process.pid}.json`);
const written = writeHeartbeat({ project: "test-project", store: "ok", memories: 3 }, heartbeatFile);
const read = readHeartbeat(heartbeatFile);
check("survives a write and read", read.project === "test-project" && read.store === "ok");
check("carries the fingerprint with it", read.abi === current.abi && read.node === current.node);
check("is timestamped", formatAge(written.at).endsWith("ago"), formatAge(written.at));
fs.rmSync(heartbeatFile, { force: true });

process.stdout.write("\n== alert suppression\n");
const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const old = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
check("a repeat within the window stays quiet", isSilenced({ signature: "a|b", notifiedAt: recent }, "a|b", 12));
check("the same problem speaks up again later", !isSilenced({ signature: "a|b", notifiedAt: old }, "a|b", 12));
check("a different problem is never suppressed", !isSilenced({ signature: "a|b", notifiedAt: recent }, "c", 12));
check("a first-ever problem is never suppressed", !isSilenced({}, "a", 12));

process.stdout.write("\n== probing a runtime for real\n");
const heartbeatBefore = readHeartbeat()?.at ?? null;
const healthy = await probeRuntime(process.execPath, { projectDir: repoRoot, timeoutMs: 90000 });
check("this node can start the memory server", healthy.ok, healthy.ok ? `${healthy.tools} tools in ${healthy.ms}ms` : healthy.error);
check("the handshake carries the memories", healthy.instructions?.includes("## Local memory (mem0-local)"));
check("the store was readable", !healthy.instructions.includes("NOT WORKING"));
// A probe that left a heartbeat would be forging evidence that a real session
// worked, which is exactly what the watchdog is trusting.
check("a probe leaves no heartbeat behind", (readHeartbeat()?.at ?? null) === heartbeatBefore);

// The real failure — an upgraded runtime that cannot load a native module —
// looks exactly like this from the outside: something spawns, and no MCP
// handshake ever comes back.
process.stdout.write("\n== probing a runtime that cannot serve\n");
const notNode = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe") : "/bin/echo";
const broken = await probeRuntime(notNode, { projectDir: repoRoot, timeoutMs: 15000 });
check("a runtime that cannot serve is caught", !broken.ok, broken.error);
check("and the failure is described, not just flagged", typeof broken.error === "string" && broken.error.length > 0);

if (process.argv.includes("--notify")) {
  process.stdout.write("\n== desktop notification\n");
  const { notify } = await import("../src/notify.mjs");
  const result = await notify({
    title: "mem0-local self-test",
    body: "If you can see this, an alert will reach you when the memory layer breaks.",
  });
  check("a notification reaches the desktop", result.delivered, result.via);
}

process.stdout.write(`\nHealth test finished: ${passed} checks passed.\n`);
