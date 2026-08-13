/**
 * Registering an unattended Windows scheduled task, shared by the watchdog and
 * the monthly sweep so that a setting which is wrong for one is never fixed in
 * only one of them.
 *
 * Two decisions are baked in here and apply to both jobs.
 *
 * The task is registered from XML rather than from `schtasks /SC` flags,
 * because three of the defaults those flags carry are wrong for a job nobody
 * is watching:
 *
 *   DisallowStartIfOnBatteries  a laptop on battery would silently never run
 *   StartWhenAvailable=false    a run missed while the PC was off is dropped
 *   (no logon trigger)          nothing runs right after a reboot, which for
 *                               the watchdog is exactly when an IDE upgrade
 *                               has just landed
 *
 * And it runs through `wscript` so no console window flashes across the screen
 * on every run — the surest way to get an unattended job uninstalled.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PATHS, ensureDirs } from "./paths.mjs";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Runtimes that ship inside an IDE, and therefore vanish when it is upgraded. */
export function isBundledRuntime(executable) {
  return /[\\/]acp-agents[\\/]|[\\/]JetBrains[\\/]/i.test(executable);
}

/**
 * A node that does not belong to any IDE. The watchdog needs this because the
 * bundled runtimes are what it monitors, and the sweep needs it because a job
 * pinned to an IDE's node stops running the day that IDE updates.
 */
export function independentNode() {
  const candidates = [path.join(process.env.ProgramFiles ?? "C:\\Program Files", "nodejs", "node.exe")];
  try {
    candidates.push(...execFileSync("where.exe", ["node"], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean));
  } catch {
    // `where` finds nothing when node is not on PATH; the explicit path above may still exist.
  }
  return candidates.find((executable) => fs.existsSync(executable) && !isBundledRuntime(executable));
}

function currentUser() {
  return `${process.env.USERDOMAIN ?? os.hostname()}\\${process.env.USERNAME ?? os.userInfo().username}`;
}

/**
 * StartBoundary carries no timezone, so Task Scheduler reads it as local time;
 * handing it a UTC stamp would put the first occurrence hours off.
 */
function localStamp(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

function triggerLines(schedule) {
  const lines = [];
  if (schedule.everyMinutes) {
    lines.push(
      "    <TimeTrigger>",
      `      <StartBoundary>${localStamp(new Date(Date.now() + 60_000))}</StartBoundary>`,
      "      <Enabled>true</Enabled>",
      "      <Repetition>",
      `        <Interval>PT${schedule.everyMinutes}M</Interval>`,
      "        <StopAtDurationEnd>false</StopAtDurationEnd>",
      "      </Repetition>",
      "    </TimeTrigger>",
    );
  }
  if (schedule.monthlyOnDay) {
    // The next occurrence of that day, so the first run is never in the past.
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth(), schedule.monthlyOnDay, schedule.atHour ?? 3, 30);
    if (first.getTime() <= now.getTime()) first.setMonth(first.getMonth() + 1);
    lines.push(
      "    <CalendarTrigger>",
      `      <StartBoundary>${localStamp(first)}</StartBoundary>`,
      "      <Enabled>true</Enabled>",
      "      <ScheduleByMonth>",
      `        <DaysOfMonth><Day>${schedule.monthlyOnDay}</Day></DaysOfMonth>`,
      `        <Months>${MONTHS.map((month) => `<${month}/>`).join("")}</Months>`,
      "      </ScheduleByMonth>",
      "    </CalendarTrigger>",
    );
  }
  if (schedule.atLogonDelay) {
    lines.push(
      "    <LogonTrigger>",
      "      <Enabled>true</Enabled>",
      `      <UserId>${currentUser()}</UserId>`,
      `      <Delay>${schedule.atLogonDelay}</Delay>`,
      "    </LogonTrigger>",
    );
  }
  return lines;
}

function taskXml({ description, launcher, schedule, timeLimit }) {
  const user = currentUser();
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    `    <Description>${description}</Description>`,
    "  </RegistrationInfo>",
    "  <Triggers>",
    ...triggerLines(schedule),
    "  </Triggers>",
    "  <Principals>",
    '    <Principal id="Author">',
    `      <UserId>${user}</UserId>`,
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <Enabled>true</Enabled>",
    `    <ExecutionTimeLimit>${timeLimit}</ExecutionTimeLimit>`,
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    "      <Command>wscript.exe</Command>",
    `      <Arguments>"${launcher}"</Arguments>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
}

/**
 * Registers (or replaces) one hidden task that runs `cli.mjs <args>`.
 * Returns which runtime it was pinned to, so the caller can warn about it.
 */
export function installHiddenTask({ name, description, launcherName, cliPath, cliArgs, schedule, timeLimit = "PT10M" }) {
  const nodeExe = independentNode() ?? process.execPath;
  const launcher = path.join(PATHS.home, launcherName);
  const command = [`""${nodeExe}""`, `""${cliPath}""`, ...cliArgs].join(" ");

  ensureDirs();
  // Quotes are doubled inside a VBS string literal; Run's third argument false
  // means fire-and-forget, and 0 means no window at all.
  fs.writeFileSync(
    launcher,
    [
      `' Generated by mem0-local: runs "${cliArgs.join(" ")}" without a console window.`,
      `CreateObject("WScript.Shell").Run "${command}", 0, False`,
      "",
    ].join("\n"),
  );

  const xmlFile = path.join(os.tmpdir(), `mem0-task-${process.pid}.xml`);
  // schtasks reads the file as UTF-16 when the declaration says so, BOM included.
  fs.writeFileSync(xmlFile, `\ufeff${taskXml({ description, launcher, schedule, timeLimit })}`, "utf16le");
  try {
    execFileSync("schtasks.exe", ["/Create", "/TN", name, "/XML", xmlFile, "/F"], { stdio: "pipe" });
  } finally {
    fs.rmSync(xmlFile, { force: true });
  }

  return { nodeExe, launcher, bundled: isBundledRuntime(nodeExe) };
}

export function removeTask(name, launcherName) {
  let removed = false;
  try {
    execFileSync("schtasks.exe", ["/Delete", "/TN", name, "/F"], { stdio: "pipe" });
    removed = true;
  } catch {
    // Not registered, which is the state the caller wanted anyway.
  }
  if (launcherName) fs.rmSync(path.join(PATHS.home, launcherName), { force: true });
  return removed;
}

/** Is a task still registered? An uninstalled unattended job is silent by definition. */
export function taskRegistered(name) {
  try {
    execFileSync("schtasks.exe", ["/Query", "/TN", name], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
