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
 *   - a reserved kind reaches a session from outside the recency window, costs
 *     nothing when the store holds none of it, and is never injected twice
 *   - the shipped `reserve` is a subset of the shipped whitelist, so no slot is
 *     promised to a kind that injection filters out anyway
 *   - a config.json written by an older version picks the corrected budget and
 *     the current kind whitelist up, while a choice made by hand survives
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

// --- a reserved kind reaches the session from outside the window --------------
// The defect this half exists for: recency spends every slot on the day's work,
// so a convention — old by nature — is missing exactly when the newest memories
// are the least validated ones.
const notesThenConvention = [
  ...Array.from({ length: 10 }, (_, index) => record(`p${index}`, 50)),
  record("con", 50, "convention"),
];
const withReserve = selectInjectionLines(notesThenConvention, {
  recent: 5,
  maxChars: 100000,
  reserve: ["convention"],
});
check(
  "a reserved kind is injected even when it is nowhere near the newest records",
  withReserve.length === 5 && idsIn(withReserve)[0] === "con-0000",
  idsIn(withReserve).join(", "),
);

// A reserved kind the store has none of must not cost the slot: otherwise every
// repository pays for the kinds it does not use, and a store of nothing but
// notes would inject fewer memories than before this existed.
const noneOfThatKind = selectInjectionLines(notesThenConvention, {
  recent: 5,
  maxChars: 100000,
  reserve: ["preference"],
});
check(
  "a reserved kind with no memories costs nothing",
  noneOfThatKind.length === 5 && !idsIn(noneOfThatKind).includes("con-0000"),
  idsIn(noneOfThatKind).join(", "),
);

// The reserve pass and the recency pass see the same records, so a reserved
// memory that is also one of the newest would be rendered twice — a duplicate
// costs a slot and reads as emphasis.
const conventionIsNewest = [record("con", 50, "convention"), record("q1", 50), record("q2", 50)];
const deduped = selectInjectionLines(conventionIsNewest, {
  recent: 3,
  maxChars: 100000,
  reserve: ["convention"],
});
check(
  "a reserved memory already in the window is injected once",
  new Set(idsIn(deduped)).size === deduped.length && deduped.length === 3,
  idsIn(deduped).join(", "),
);

// `recent` is the ceiling on the whole list, not on the recency pass alone.
const reserveOverflow = selectInjectionLines(
  [record("con", 50, "convention"), record("pre", 50, "preference"), record("dec", 50, "decision")],
  { recent: 2, maxChars: 100000, reserve: ["convention", "preference", "decision"] },
);
check(
  "reserved kinds cannot push the list past inject.recent",
  reserveOverflow.length === 2,
  `${reserveOverflow.length} line(s)`,
);

// --- reserve and the whitelist must not contradict each other -----------------
// The whitelist is applied before selection, so a kind reserved but not
// whitelisted is a slot promised to memories that never arrive — the same shape
// of silent lie as a budget too small for `recent`.
const { reserve, kinds } = loadConfig().inject;
check(
  "every reserved kind is one injection is allowed to carry",
  reserve.every((kind) => kinds.includes(kind)),
  `reserve [${reserve.join(", ")}] against [${kinds.join(", ")}]`,
);
check(
  "the reserve leaves room for recency",
  reserve.length < recent,
  `${reserve.length} reserved of ${recent} slots`,
);

// --- what did not fit still has to be reachable -------------------------------
// Reserving a few kinds narrows the gap but does not close it: the store holds
// more conventions than the one slot carries. The protocol is what keeps the
// rest reachable, which makes its instruction to search a load-bearing part of
// injection rather than decoration — and in an ACP host, where no hook fires per
// turn, the only query-time retrieval that happens at all.
check(
  "the protocol tells the agent to search beyond what was injected",
  MEMORY_PROTOCOL.includes("memory_search") && MEMORY_PROTOCOL.includes("memory_add"),
);
check(
  "the protocol names the searches to run rather than asking for a search",
  MEMORY_PROTOCOL.includes('kind: "convention"') && MEMORY_PROTOCOL.includes('kind: "decision"'),
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

// --- the same, for the whitelist a new kind has to get into -------------------
// A list is replaced wholesale by the merge rather than merged, so a kind added
// after an install wrote its snapshot would be storable and never injected —
// the quietest failure this layer has, because the memory is right there in
// `list` and simply never reaches a session.
const OLD_KINDS = ["preference", "convention", "decision", "gotcha", "fact", "note"];
const staleKinds = inTempHome({ recent: 8, kinds: OLD_KINDS });
check(
  "a whitelist written before a kind existed picks that kind up",
  staleKinds.effective.kinds.includes("context") && staleKinds.persisted.kinds.includes("context"),
  `effective [${staleKinds.effective.kinds.join(", ")}]`,
);
const chosenKinds = inTempHome({ recent: 8, kinds: ["convention", "gotcha"] });
check(
  "a whitelist chosen by hand is left alone",
  chosenKinds.effective.kinds.join() === "convention,gotcha",
  `effective [${chosenKinds.effective.kinds.join(", ")}]`,
);

out(failures === 0 ? "\nInjection selection verified." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
