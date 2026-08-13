#!/usr/bin/env node
/**
 * Pins down what a fresh session is actually handed. Both injection channels
 * (Cursor's sessionStart hook and the MCP handshake) share one selection step,
 * and every way it loses a memory is silent: an agent that was never told about
 * a convention behaves exactly like one that has no memory layer at all.
 *
 * What it pins down:
 *   - one over-long memory costs only itself, not everything behind it
 *   - the two limits agree, so the shipped `recent` is reachable in practice
 *   - `recent` still caps the list once the budget stops binding
 *   - nothing fitting yields no lines, which is what lets the caller say so
 *     instead of reporting the repository as empty
 *   - a config.json written by an older version picks the corrected budget up,
 *     while a figure chosen by hand survives
 *
 * Needs no store and no embedding model, so it runs in milliseconds.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.mjs";
import { MEMORY_PROTOCOL, selectInjectionLines } from "../src/injection.mjs";

const out = (line) => process.stdout.write(`${line}\n`);

let failures = 0;
const check = (label, ok, detail) => {
  out(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

/**
 * A stand-in memory of a given text length. Lists are written newest first,
 * which is the order `listMemories` hands to the builder.
 */
const record = (name, textChars, kind = "note") => ({
  id: `${name}-0000000000000000000000000000`,
  kind,
  text: name.repeat(Math.max(1, Math.ceil(textChars / name.length))).slice(0, textChars),
});

const idsIn = (lines) => lines.map((line) => line.match(/\(id: ([^)]+)\)/)?.[1] ?? "?");
const totalChars = (lines) => lines.reduce((total, line) => total + line.length, 0);

// --- one long memory must not end the list -----------------------------------
// The regression this suite exists for: stopping at the first oversized record
// used to hide every memory behind it, which is how a founding convention goes
// missing while the day's incidental notes stay.
const withOneGiant = [record("aaa", 100), record("bbb", 4000), record("ccc", 100), record("ddd", 100)];
const survived = selectInjectionLines(withOneGiant, { recent: 8, maxChars: 500 });
check(
  "a memory too long for the budget costs only itself, not the ones behind it",
  survived.length === 3 && idsIn(survived).join() === "aaa-0000,ccc-0000,ddd-0000",
  idsIn(survived).join(", "),
);

// --- nothing fitting is distinguishable from having nothing ------------------
const noneFit = selectInjectionLines([record("hhh", 900), record("iii", 900)], { recent: 8, maxChars: 200 });
check("a list where nothing fits yields no lines", noneFit.length === 0, `${noneFit.length} line(s)`);

// --- the budget is never exceeded --------------------------------------------
const tight = selectInjectionLines([record("eee", 200), record("fff", 200), record("ggg", 200)], {
  recent: 8,
  maxChars: 450,
});
check("the character budget holds", totalChars(tight) <= 450, `${totalChars(tight)} of 450 chars`);

// --- recent and maxChars must not contradict each other ----------------------
// Whichever limit binds first wins, so a maxChars too small for `recent`
// records makes the configured `recent` a number that never happens.
const { recent, maxChars } = loadConfig().inject;
// Sized in rendered lines, not in memory text: the `[kind]` prefix and the id
// suffix are part of what the budget pays for. 625 is the upper end of what
// this repository's own memories measure, so the shipped budget has headroom.
const TYPICAL_LINE = 625;
const overhead = selectInjectionLines([record("x", 10)], { recent: 1, maxChars: 1000 })[0].length - 10;
const typical = Array.from({ length: recent }, (_, index) => record(`m${index}`, TYPICAL_LINE - overhead));
const fitted = selectInjectionLines(typical, { recent, maxChars });
check(
  "the shipped budget can hold inject.recent typical memories",
  fitted.length === recent,
  `${fitted.length} of ${recent} at ${maxChars} chars (${recent * TYPICAL_LINE} needed)`,
);

// --- recent still caps the list ----------------------------------------------
const many = Array.from({ length: 20 }, (_, index) => record(`n${index}`, 50));
const capped = selectInjectionLines(many, { recent: 5, maxChars: 100000 });
check("inject.recent caps the list when the budget is generous", capped.length === 5, `${capped.length} line(s)`);

// --- what did not fit still has to be reachable -------------------------------
// Selection is recency-only, so an old convention loses its slot to the day's
// incidental notes. The protocol is what keeps it reachable anyway, which makes
// its instruction to search a load-bearing part of injection, not decoration.
check(
  "the protocol tells the agent to search beyond what was injected",
  MEMORY_PROTOCOL.includes("memory_search") && MEMORY_PROTOCOL.includes("memory_add"),
);

// --- an existing install has to pick the corrected budget up ------------------
// `ensureConfigFile` snapshots every default into config.json on first run, so
// raising a default in the source reaches new machines only. Run against a
// throwaway home, in a child process because the paths are resolved at import.
const src = path.dirname(fileURLToPath(import.meta.url));
const inTempHome = (inject) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mem0-local-inject-"));
  try {
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ userId: "probe", inject }));
    const stdout = execFileSync(
      process.execPath,
      [
        "-e",
        "import('../src/config.mjs').then(m => console.log(JSON.stringify(m.ensureConfigFile().inject)))",
      ],
      { cwd: src, env: { ...process.env, MEM0_LOCAL_HOME: home }, encoding: "utf8" },
    );
    return {
      effective: JSON.parse(stdout.trim()),
      persisted: JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).inject,
    };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
};

const stale = inTempHome({ recent: 8, maxChars: 2500 });
check(
  "a config.json left at the superseded budget is brought up to date",
  stale.effective.maxChars === maxChars,
  `effective ${stale.effective.maxChars}, wanted ${maxChars}`,
);
check(
  "and the file is rewritten, so it stops contradicting the behaviour",
  stale.persisted.maxChars === maxChars,
  `on disk ${stale.persisted.maxChars}`,
);

// The migration keys off the exact superseded value, which is the only thing
// separating "never touched" from "deliberately set" in a file with no version.
const chosen = inTempHome({ recent: 8, maxChars: 1200 });
check(
  "a budget chosen by hand is left alone",
  chosen.effective.maxChars === 1200 && chosen.persisted.maxChars === 1200,
  `effective ${chosen.effective.maxChars}, on disk ${chosen.persisted.maxChars}`,
);

out(failures === 0 ? "\nInjection selection verified." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
