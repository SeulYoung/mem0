#!/usr/bin/env node
/**
 * Drives the CLI as a real process. It is the only surface a human touches, and
 * its argument parsing decides what text actually gets stored — a flag value
 * leaking into the memory body is silent corruption, so it is pinned here.
 *
 * It also covers the one command that deletes without being asked twice: the
 * monthly sweep of expired memories. That runs unattended, so what it selects
 * matters more than what it prints.
 *
 * Costs nothing: no model calls, and every memory it writes is deleted again.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { deleteMemory, listMemories, routeConsoleToStderr } from "../src/memory.mjs";
import { PATHS } from "../src/paths.mjs";
import { resolveProject } from "../src/project.mjs";

routeConsoleToStderr();

// The sweep records its run for doctor to report; a test sweep must not be left
// standing there as if it were the real monthly one.
const sweepStampBefore = fs.existsSync(PATHS.sweepFile) ? fs.readFileSync(PATHS.sweepFile, "utf8") : null;

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.mjs");
const MARKER = "命令行参数回归";
const BODY = `${MARKER}：正文必须干净结尾，不带任何开关的值。`;

const out = (line) => process.stdout.write(`${line}\n`);
let failures = 0;
const check = (label, ok, detail) => {
  out(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

function run(...args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`cli ${args.join(" ")} exited ${result.status}: ${result.stderr}`);
  return result;
}

// Almost every case here reads the records the CLI printed, which is stdout;
// the two streams are separated on purpose, so a diagnostic can never be
// mistaken for a memory by whatever is reading the output.
const cli = (...args) => run(...args).stdout;

try {
  // A value flag after the text: "convention" must not become part of the body.
  const added = cli("add", BODY, "--kind", "convention");
  check("a flag value does not leak into the stored text", added.includes(BODY) && !added.includes(`${BODY} convention`));
  check("the value flag was applied", added.includes("[convention]"), added.split("\n")[0]);

  // A switch placed before the text: the query must survive it.
  const searched = run("search", "--all", MARKER, "--top", "3");
  check(
    "a switch before the query does not swallow the query",
    searched.stdout.includes(BODY),
    searched.stdout.split("\n")[0],
  );

  // The marker is pure CJK, so this search also covers the one query shape
  // mem0's keyword index and entity extractors cannot see. Where it lands
  // matters as much as that it appears: on stderr it stays out of the records,
  // and `test-retrieval.mjs` is what pins down when it fires.
  check(
    "a query that reaches only the embedding model says so, on stderr",
    searched.stderr.includes("no Latin letters or digits") && !searched.stdout.includes("no Latin letters"),
  );

  const explained = cli("search", MARKER, "--top", "2", "--explain");
  check("--explain reports mem0's per-signal scores", /signals: semanticScore=/.test(explained));

  // The listing prints eight-character ids, so those have to be enough to act on.
  const shortId = added.trim().split(/\s+/)[0];
  const corrected = `${MARKER}：改正后的正文，仍然干净结尾。`;
  const updated = cli("update", shortId, corrected, "--kind", "gotcha");
  check("a shortened id from the listing is enough to update", updated.includes(corrected), updated.split("\n")[0]);
  check("the update moved the memory to the new kind", updated.includes("[gotcha]"));

  // The one thing an in-place edit destroys is the previous wording, and mem0's
  // change log is the only copy of it.
  const history = cli("history", shortId);
  check("history shows the text the update replaced", history.includes(`was  ${BODY}`), history.split("\n")[0]);
  check("history shows the text it was replaced with", history.includes(`now  ${corrected}`));
  check("history keeps the write that created it", /\bADD\b/.test(history) && /\bUPDATE\b/.test(history));

  const expired = cli("update", shortId, "--expires", "2020-01-01");
  check("--expires is recorded on the memory", expired.includes("expires=2020-01-01"));
  check("an expired memory disappears from the listing", !cli("list", "--limit", "50").includes(corrected));
  check("list --expired still shows it", cli("list", "--limit", "50", "--expired").includes(corrected));
  // Resolving this shortened id proves an expiry stays reversible: the memory is
  // invisible to the plain listing at this point.
  cli("update", shortId, "--clear-expiry");
  check("--clear-expiry brings it back", cli("list", "--limit", "50").includes(corrected));

  const listed = cli("list", "--limit", "1");
  check("--limit is honoured", listed.trim().split("\n").length === 2, `${listed.trim().split("\n").length} line(s)`);

  const stats = JSON.parse(cli("stats"));
  check("stats reports the local store", stats.dataDir?.includes(".mem0-local") && stats.total >= 1);

  // --- the monthly sweep -------------------------------------------------------
  // Last, because it is the one case that deletes the fixture the earlier checks
  // rely on. Expiry only hides a memory; the sweep is the only thing that removes
  // it, and the grace window is what keeps an expiry reversible for a while, so
  // being one day late must not be enough.
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  cli("update", shortId, "--expires", yesterday);
  check(
    "a memory expired yesterday survives the default grace window",
    !cli("prune", "--expired").includes(corrected),
  );
  const due = cli("prune", "--expired", "--days", "0");
  check("with no grace it is due", due.includes(corrected));
  check("listing what is due deletes nothing", cli("list", "--limit", "50", "--expired").includes(corrected));

  // The sweep spans every repository, so a real deletion here would take any
  // genuinely expired memory with it. Run it only when this fixture is the one
  // thing due — the alternative is a test that can cost you real memories.
  const dueCount = Number(due.match(/^(\d+)/)?.[1] ?? 0);
  if (dueCount === 1) {
    const swept = cli("prune", "--expired", "--days", "0", "--yes");
    check("--yes deletes what is due", swept.includes("Deleted 1."), swept.trim().split("\n").pop());
    check("and it is gone from the expired listing too", !cli("list", "--limit", "50", "--expired").includes(corrected));
    const stamp = JSON.parse(fs.readFileSync(PATHS.sweepFile, "utf8"));
    check(
      "the sweep records itself, so doctor can tell it apart from never having run",
      stamp.deleted === 1 && Date.now() - Date.parse(stamp.at) < 60_000,
      JSON.stringify(stamp),
    );
  } else {
    out(`SKIP  deleting for real — ${dueCount} memories are due, and they are not this test's to delete`);
    cli("update", shortId, "--clear-expiry");
  }

  out(failures === 0 ? "\nCLI surface verified." : `\n${failures} check(s) failed.`);
} finally {
  // Teardown goes through the library: the CLI prints shortened ids, and
  // deletion needs the full one.
  if (sweepStampBefore === null) fs.rmSync(PATHS.sweepFile, { force: true });
  else fs.writeFileSync(PATHS.sweepFile, sweepStampBefore);

  const project = resolveProject();
  const removed = [];
  // Expired too: this test sets an expiry, and a failure in between would
  // otherwise leave a record no later listing can see.
  for (const record of await listMemories({ project, limit: 100, scope: "project", includeExpired: true })) {
    if (!record.text.includes(MARKER)) continue;
    await deleteMemory(record.id, project);
    removed.push(record.id);
  }
  out(`\ncleaned up ${removed.join(", ") || "(nothing)"}`);
}

process.exit(failures === 0 ? 0 : 1);
