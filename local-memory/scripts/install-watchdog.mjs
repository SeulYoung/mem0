#!/usr/bin/env node
/**
 * Registers the watchdog as a Windows scheduled task, so the memory layer is
 * checked whether or not you remember to check it.
 *
 *   npm run install-watchdog        [-- --every 15]
 *   npm run uninstall-watchdog
 *
 * It deliberately runs on a node outside the IDE: the runtime bundled with an
 * IDE is one of the things being monitored, and a watchdog that dies with its
 * subject is not a watchdog. How the task itself is registered — and why from
 * XML rather than schtasks flags — is in src/scheduled-task.mjs.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.mjs";
import { WATCHDOG_TASK } from "../src/health.mjs";
import { installHiddenTask, removeTask } from "../src/scheduled-task.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, "..", "src", "cli.mjs");
const LAUNCHER = "watchdog.vbs";

const log = (message) => process.stdout.write(`${message}\n`);

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

if (process.platform !== "win32") {
  log("The scheduled task installer is Windows-only. On macOS or Linux, run this from cron instead:");
  log(`  */15 * * * * "${process.execPath}" "${cliPath}" watch`);
  process.exit(0);
}

if (process.argv.includes("--uninstall")) {
  log(
    removeTask(WATCHDOG_TASK, LAUNCHER)
      ? `Removed the scheduled task "${WATCHDOG_TASK}".`
      : `No scheduled task named "${WATCHDOG_TASK}" was registered.`,
  );
  log("Memories and configuration are untouched.");
  process.exit(0);
}

const everyMinutes = Number(argument("every", loadConfig().watchdog?.everyMinutes ?? 15));

const { nodeExe, bundled } = installHiddenTask({
  name: WATCHDOG_TASK,
  description:
    "Checks that the mem0-local memory layer can still start, and raises a desktop alert when it cannot.",
  launcherName: LAUNCHER,
  cliPath,
  cliArgs: ["watch"],
  schedule: { everyMinutes, atLogonDelay: "PT2M" },
});

if (bundled) {
  log("Warning: the only node found lives inside an IDE installation. The watchdog will stop working");
  log("         when that IDE is upgraded. Install node system-wide and re-run this to fix that.");
}

log(`Registered "${WATCHDOG_TASK}": every ${everyMinutes} minutes and 2 minutes after each logon,`);
log(`hidden, on ${nodeExe}`);
log("");
log("It starts the memory server under every IDE-bundled runtime it can find and alerts you when");
log("one of them cannot come up — which is what an agent upgrade or a broken native module looks like.");
log("");
log(`Run it once now:      node "${cliPath}" watch`);
log(`Check the schedule:   schtasks /Query /TN "${WATCHDOG_TASK}"`);
log(`See the last verdict: node "${cliPath}" doctor`);
