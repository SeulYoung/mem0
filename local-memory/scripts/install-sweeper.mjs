#!/usr/bin/env node
/**
 * Registers the monthly sweep of expired memories as a Windows scheduled task.
 *
 *   npm run install-sweeper        [-- --day 15]
 *   npm run uninstall-sweeper
 *
 * Why a sweep at all, and why it is not folded into the watchdog run: expiry
 * only hides a memory, and an expired row still perturbs the scores of visible
 * ones (see DESIGN.md). But the watchdog runs every couple of hours and its
 * probes are exercised by the test suite, so giving that path the power to
 * delete would let a test run mutate the real store.
 *
 * The task passes no --days: the grace window is read from config at sweep
 * time, so `prune.expiredGraceDays` can change without re-registering anything.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.mjs";
import { SWEEP_TASK } from "../src/health.mjs";
import { installHiddenTask, removeTask } from "../src/scheduled-task.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, "..", "src", "cli.mjs");
const LAUNCHER = "sweep.vbs";

const log = (message) => process.stdout.write(`${message}\n`);

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const config = loadConfig();
const graceDays = config.prune?.expiredGraceDays ?? 30;

if (process.platform !== "win32") {
  log("The scheduled task installer is Windows-only. On macOS or Linux, run this from cron instead:");
  log(`  30 3 1 * * "${process.execPath}" "${cliPath}" prune --expired --yes`);
  process.exit(0);
}

if (process.argv.includes("--uninstall")) {
  log(
    removeTask(SWEEP_TASK, LAUNCHER)
      ? `Removed the scheduled task "${SWEEP_TASK}".`
      : `No scheduled task named "${SWEEP_TASK}" was registered.`,
  );
  log("Nothing is deleted by uninstalling: expired memories simply stay in the store.");
  process.exit(0);
}

const dayOfMonth = Number(argument("day", config.prune?.dayOfMonth ?? 1));

const { nodeExe, bundled } = installHiddenTask({
  name: SWEEP_TASK,
  description: `Deletes mem0-local memories that have been expired for more than ${graceDays} days.`,
  launcherName: LAUNCHER,
  cliPath,
  cliArgs: ["prune", "--expired", "--yes"],
  schedule: { monthlyOnDay: dayOfMonth, atHour: 3 },
  // Long enough to cover loading the embedding model on a cold machine.
  timeLimit: "PT15M",
});

if (bundled) {
  log("Warning: the only node found lives inside an IDE installation, so the sweep will stop running");
  log("         when that IDE is upgraded. Install node system-wide and re-run this to fix that.");
}

log(`Registered "${SWEEP_TASK}": day ${dayOfMonth} of each month at 03:30, hidden, on ${nodeExe}`);
log(`It deletes memories expired for more than ${graceDays} days (config prune.expiredGraceDays).`);
log("");
log(`See what it would delete: node "${cliPath}" prune --expired`);
log(`Run it now:               node "${cliPath}" prune --expired --yes`);
log(`Check the schedule:       schtasks /Query /TN "${SWEEP_TASK}"`);
log(`See the last sweep:       node "${cliPath}" doctor`);
