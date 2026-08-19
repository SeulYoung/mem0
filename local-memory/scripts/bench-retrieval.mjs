#!/usr/bin/env node
/**
 * Measures whether the rule this layer gives agents for CJK identifiers — copy
 * them verbatim, and put English words describing them in the same sentence —
 * actually retrieves. That rule is the arbitration between `ENGLISH_ONLY` and
 * `KEEP_IDENTIFIERS`, and until this script it was the only claim in
 * `wording.mjs` with no measurement behind it: the numbers that produced it
 * (0.98 cosine for adding a CJK identifier, 0.66-0.75 between unrelated ones)
 * describe identifiers in isolation, not memories written the way it asks.
 *
 * Unlike `bench-embedding.mjs`, which compares embedding models on raw cosine
 * over a fixed fixture, this goes through `searchMemories` — mem0's three fused
 * signals plus the cross-encoder — because that is what an agent actually hits,
 * and two of those three treat CJK differently from the embedder.
 *
 * Fixtures are written through mem0's extraction path with a stub model, the
 * way `test-retrieval.mjs` does it: free, deterministic, and the only write path
 * that populates the entity store, which is the signal under suspicion here.
 * They live in their own repository so the entity index is isolated, and are
 * deleted afterwards.
 *
 * Half bench, half guard: the rule is shipped to agents as prompt text, so the
 * claims it rests on are asserted and a regression exits non-zero, while the
 * numbers that legitimately drift are only printed.
 *
 * The last section needs no fixtures: it profiles the cross-encoder's score
 * curve on the repository you run it in, to size the relative cutoff a rerank
 * floor would use. Ground-truth free on purpose, so it does not rot as the store
 * grows — and unable, for the same reason, to say whether a cut would have been
 * wrong.
 *
 * Usage: node scripts/bench-retrieval.mjs [--keep]
 *        MEM0_LOCAL_BENCH_ROOT=D:\some\repo node scripts/bench-retrieval.mjs
 */
import { loadConfig } from "../src/config.mjs";
import { createEmbedder } from "../src/embedder.mjs";
import {
  deleteMemory,
  listMemories,
  memoryConfig,
  routeConsoleToStderr,
  scopeFilters,
  searchMemories,
} from "../src/memory.mjs";
import { resolveProject } from "../src/project.mjs";

routeConsoleToStderr();

const config = loadConfig();
const out = (line = "") => process.stdout.write(`${line}\n`);
const keep = process.argv.includes("--keep");

/**
 * The numbers below are a measurement, but two of the claims they support are
 * shipped to agents as prompt text, so they get a verdict as well: the rule that
 * `KEEP_IDENTIFIERS` states has to keep working, not merely have worked once.
 * `test-prompts.mjs` already guards that the text still *says* it; nothing until
 * now guarded that it is still *true*. Everything else here stays informational,
 * because it legitimately moves with the store.
 */
let failures = 0;
const check = (label, ok, detail) => {
  out(`   ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const BENCH_REPO = { id: "bench-cjk", name: "bench-cjk", root: "C:\\nonexistent\\bench-cjk" };
const QUOTED_REPO = { id: "bench-cjk-quoted", name: "bench-cjk-quoted", root: "C:\\nonexistent\\bench-cjk-quoted" };

/**
 * Written the way `KEEP_IDENTIFIERS` now asks for: English prose, the CJK
 * identifier verbatim, and English words naming what it is in the same
 * sentence. Modelled on the HappyArena report that prompted the rule — a
 * project whose table names, worksheet names and log strings are Chinese.
 *
 * Four of the eight carry no CJK at all. They are not padding: a retrieval
 * measurement over three documents that all answer different questions says
 * nothing, and the distractors are what a wrong answer can be wrong *into*.
 */
const CORPUS = [
  {
    tag: "item-table",
    text: "Item configuration for HappyArena is authored in the workbook 物品表.xlsx (the item table) under HappyArenaProtoRes/input-xlsx/物品/, and the conversion script selects it with --tables 物品表.",
  },
  {
    tag: "artifact-sheet",
    text: "The 神器 worksheet (artifacts) carries one row per artifact, while 神器基础表 (the artifact base table) holds the shared stats those rows inherit, so editing only the first leaves the defaults untouched.",
  },
  {
    tag: "airdrop-chest",
    text: "The airdrop chest 空投宝箱 is spawned through SpawnItemChestByLootIdQuality rather than a dedicated chest class, so looking for a BP_ItemChest subclass to change finds nothing.",
  },
  {
    tag: "shared-tree",
    text: "ST_CapturableNeturalTree_Base is shared by six capturable assets, so changing the state tree for the chest alone means duplicating it first rather than editing it in place.",
  },
  {
    tag: "smart-vpn",
    text: "iOA SmartVPN intercepts UDP on the office network, so a client cannot reach a dedicated server hosted on the same machine until SmartVPN is turned off.",
  },
  {
    tag: "nullrhi",
    text: "Launching the dedicated server with -nullrhi crashes on startup in shipping builds unless -unattended is passed alongside it.",
  },
  {
    tag: "exit-status",
    text: "A stress-test harness must end its run with RequestExitWithStatus, because a plain process exit skips the analytics flush and the run reports no results.",
  },
  {
    tag: "randkey",
    text: "The randkey handshake rejects a client whose build hash differs from the server's, and it shows up as a silent disconnect rather than as an error in the log.",
  },
];

/**
 * Three families, because they ask three different questions of the same rule.
 * A is the one that decides whether the rule works at all: if an English
 * question that never mentions the identifier cannot find the memory, then the
 * English gloss is not doing the job the rule claims for it.
 */
const FAMILIES = [
  {
    key: "A",
    title: "English question, never naming the CJK identifier — does the gloss carry retrieval?",
    // The load-bearing one. If an English question cannot reach a memory written
    // the way the rule asks, the rule is telling agents to do something useless.
    expect: 3,
    queries: [
      { q: "where is item configuration authored", tag: "item-table" },
      { q: "which worksheet holds the shared artifact stats", tag: "artifact-sheet" },
      { q: "how is the airdrop chest spawned", tag: "airdrop-chest" },
    ],
  },
  {
    key: "B",
    title: "the CJK identifier alone — does copying it verbatim buy anything at query time?",
    // Reported, not asserted: this is the case the rule openly cannot rescue, and
    // pinning today's 2/3 would only make an embedder change look like a break.
    expect: null,
    queries: [
      { q: "物品表", tag: "item-table" },
      { q: "神器基础表", tag: "artifact-sheet" },
      { q: "空投宝箱", tag: "airdrop-chest" },
    ],
  },
  {
    key: "C",
    title: "English sentence naming the CJK identifier — how an agent following the rule would really ask",
    expect: 2,
    queries: [
      { q: "which script converts 物品表", tag: "item-table" },
      { q: "is there a dedicated class for 空投宝箱", tag: "airdrop-chest" },
    ],
  },
  {
    key: "D",
    title: "ASCII identifier control — the same shape of question where every signal works",
    // A failure here is the pipeline breaking, not the CJK rule breaking; it is
    // what tells the two apart when A goes red.
    expect: 2,
    queries: [
      { q: "ST_CapturableNeturalTree_Base", tag: "shared-tree" },
      { q: "which state tree is shared between several assets", tag: "shared-tree" },
    ],
  },
];

/** A model that answers mem0's extraction prompt with one fact, verbatim. */
let stubReply = "";
const stub = {
  model: "stub",
  async invoke() {
    return { content: JSON.stringify({ memory: [{ id: "0", text: stubReply }] }) };
  },
};

/**
 * The same three subjects, with the CJK identifier in double quotes. mem0's
 * entity extraction takes quoted spans whatever they contain, but its bare
 * identifier pattern needs an ASCII letter — so quoting is the one way a CJK
 * name reaches the entity index, and the only condition under which the
 * predicted misfire can happen at all.
 */
const QUOTED_CORPUS = [
  {
    tag: "q-item-table",
    text: 'Item configuration is authored in the workbook "物品表" (the item table), which the conversion script reads first.',
  },
  {
    tag: "q-artifact",
    text: 'The worksheet "神器基础表" (the artifact base table) holds the stats every artifact row inherits.',
  },
  {
    tag: "q-chest",
    text: 'The airdrop chest "空投宝箱" has no class of its own and is spawned from a loot id instead.',
  },
];

async function writeCorpus(project, docs) {
  const { Memory } = await import("mem0ai/oss");
  const memory = new Memory(memoryConfig({ config, embedder: createEmbedder(config), llm: stub }));
  for (const doc of docs) {
    stubReply = doc.text;
    // The repository travels in `filters`, which is where mem0 reads `agent_id`
    // from and stamps it on the record — the same way `addMemory` writes.
    await memory.add(`Remember this: ${doc.text}`, {
      userId: config.userId,
      filters: scopeFilters(config, project, "project"),
      metadata: { project_name: project.name, kind: "fact", source: "bench:retrieval" },
      infer: true,
    });
  }
}

async function wipe(project) {
  for (const record of await listMemories({ project, limit: 500, scope: "project", includeExpired: true })) {
    if (record.project === project.id) await deleteMemory(record.id, project);
  }
}

const byText = new Map([...CORPUS, ...QUOTED_CORPUS].map((doc) => [doc.text, doc.tag]));
const tagOf = (record) => byText.get(record.text) ?? "?";

/**
 * A floor of exactly 0 would be indistinguishable from "unset" if mem0 ever
 * tests it for truthiness, and the whole point here is to see the full ranking
 * including the hits a default floor would have dropped.
 */
const NO_FLOOR = 1e-6;

const pad = (value, width) => String(value).padEnd(width);
const num = (value, digits = 3) => (typeof value === "number" ? value.toFixed(digits) : "  -  ");

async function runFamilies() {
  const summary = [];
  for (const family of FAMILIES) {
    out("");
    out(`== ${family.key}. ${family.title}`);
    out("");
    out(`   ${pad("query", 50)}${pad("hit", 5)}${pad("rank", 6)}${pad("rerank", 10)}${pad("sem", 8)}${pad("bm25", 8)}entity`);
    let top1 = 0;
    let reciprocal = 0;
    for (const { q, tag } of family.queries) {
      const results = await searchMemories({
        query: q,
        project: BENCH_REPO,
        topK: CORPUS.length,
        explain: true,
        threshold: NO_FLOOR,
      });
      const tags = results.map(tagOf);
      const rank = tags.indexOf(tag) + 1;
      const correct = results[rank - 1];
      const signals = correct?.scoreDetails ?? {};
      if (rank === 1) top1 += 1;
      if (rank > 0) reciprocal += 1 / rank;
      out(
        `   ${pad(q, 50)}${pad(rank === 1 ? "yes" : "NO", 5)}${pad(rank || "-", 6)}` +
          `${pad(num(correct?.rerankScore, 4), 10)}${pad(num(signals.semanticScore), 8)}` +
          `${pad(num(signals.bm25Score), 8)}${num(signals.entityBoost)}`,
      );
      if (rank !== 1) out(`   ${" ".repeat(50)}top hit was "${tags[0]}"`);
    }
    const n = family.queries.length;
    out("");
    out(`   top-1 ${top1}/${n}   MRR ${(reciprocal / n).toFixed(3)}`);
    if (typeof family.expect === "number") {
      check(`${family.key}: still ${family.expect}/${n} at top-1`, top1 >= family.expect, `got ${top1}`);
    }
    summary.push({ key: family.key, top1, n, mrr: reciprocal / n });
  }
  return summary;
}

/**
 * The failure mode the isolated cosines predicted: two unrelated CJK
 * identifiers sit at 0.66-0.75, above the entity store's own 0.5 match
 * threshold, so a query naming one of them could boost the other's memory.
 * Isolated similarity says it should happen; this says whether it does, in a
 * store where the entity rows were written by mem0 itself.
 *
 * Returns how many of the cases boosted a memory that was not theirs, which is
 * what the two halves of "write the identifier bare" are asserted on.
 */
async function checkEntityMisfire(project, docs, cases, label) {
  out("");
  out(`== entity misfire, ${label} — a query naming one CJK identifier must not boost another's memory`);
  out("");
  let misfired = 0;
  for (const { q, tag } of cases) {
    const results = await searchMemories({
      query: q,
      project,
      topK: docs.length,
      explain: true,
      threshold: NO_FLOOR,
    });
    const boosted = results.filter((record) => (record.scoreDetails?.entityBoost ?? 0) > 0);
    const wrong = boosted.filter((record) => tagOf(record) !== tag);
    const shown = boosted.map((record) => `${tagOf(record)} ${num(record.scoreDetails.entityBoost)}`);
    out(`   ${pad(`query ${q}`, 22)}boosted: ${shown.length > 0 ? shown.join(", ") : "(nothing — no entity was extracted from the query)"}`);
    if (wrong.length > 0) {
      misfired += 1;
      out(`   ${" ".repeat(22)}MISFIRE onto ${wrong.map(tagOf).join(", ")}`);
    }
  }
  return misfired;
}

/**
 * What a relative rerank floor would do, on whatever repository this is run in.
 * No ground truth, so it cannot say a cut was wrong — it reports where each
 * candidate cutoff bites, which is the number needed to choose one, and stays
 * meaningful as the store changes.
 */
const CUTOFFS = [0.001, 0.01, 0.05];
const PROFILE_QUERIES = [
  "why is this written the way it is",
  "how are repositories kept separate",
  "what did we measure about retrieval",
  "which files must never be edited",
  "how does session injection choose what to send",
  "what breaks when the embedding model changes",
];

async function profileRerank(project) {
  const total = (await listMemories({ project, limit: 100000, scope: "project" })).length;
  out("");
  out(`== rerank score profile — what a relative floor would cut, over ${total} memories in ${project.id}`);
  out("");
  if (total === 0) {
    out("   nothing to profile. Run this from the repository whose store you want to see, or point");
    out("   MEM0_LOCAL_BENCH_ROOT at it — running from a subdirectory resolves to a different project.");
    return;
  }
  out(`   ${pad("query", 50)}${pad("hits", 6)}${pad("top", 10)}${pad("median", 10)}kept at 0.1% / 1% / 5% of top`);
  for (const query of PROFILE_QUERIES) {
    const results = await searchMemories({
      query,
      project,
      topK: 20,
      threshold: NO_FLOOR,
    });
    const scores = results.map((record) => record.rerankScore).filter((score) => typeof score === "number");
    if (scores.length === 0) {
      out(`   ${pad(query, 50)}(no rerank scores — is the reranker enabled?)`);
      continue;
    }
    const top = scores[0];
    const median = scores[Math.floor(scores.length / 2)];
    const kept = CUTOFFS.map((fraction) => scores.filter((score) => score >= top * fraction).length);
    out(
      `   ${pad(query, 50)}${pad(scores.length, 6)}${pad(num(top, 4), 10)}${pad(num(median, 6), 10)}` +
        kept.join(" / "),
    );
  }
}

const started = Date.now();
out(
  `corpus: ${CORPUS.length} memories in \`${BENCH_REPO.id}\` and ${QUOTED_CORPUS.length} in ` +
    `\`${QUOTED_REPO.id}\`, written through mem0's extraction path`,
);
await wipe(BENCH_REPO);
await wipe(QUOTED_REPO);
await writeCorpus(BENCH_REPO, CORPUS);
await writeCorpus(QUOTED_REPO, QUOTED_CORPUS);

const summary = await runFamilies();
const misfiredBare = await checkEntityMisfire(
  BENCH_REPO,
  CORPUS,
  [
    { q: "物品表", tag: "item-table" },
    { q: "空投宝箱", tag: "airdrop-chest" },
    { q: "神器基础表", tag: "artifact-sheet" },
  ],
  "identifier written bare",
);
const misfiredQuotedMemory = await checkEntityMisfire(
  QUOTED_REPO,
  QUOTED_CORPUS,
  [
    { q: "物品表", tag: "q-item-table" },
    { q: "空投宝箱", tag: "q-chest" },
    { q: "神器基础表", tag: "q-artifact" },
  ],
  "identifier in double quotes",
);
// The only configuration in which the entity route is reachable from a CJK
// name at all: quoted in the memory, and quoted again in the query. Anything
// milder fails the query-side extractor before a match is ever attempted.
const misfiredBothQuoted = await checkEntityMisfire(
  QUOTED_REPO,
  QUOTED_CORPUS,
  [
    { q: '"物品表"', tag: "q-item-table" },
    { q: '"空投宝箱"', tag: "q-chest" },
    { q: '"神器基础表"', tag: "q-artifact" },
  ],
  "quoted on both sides",
);

out("");
out("== summary");
out("");
for (const row of summary) out(`   ${row.key}  top-1 ${row.top1}/${row.n}   MRR ${row.mrr.toFixed(3)}`);
out("");
check(
  "writing the identifier bare keeps the entity route shut",
  misfiredBare === 0 && misfiredQuotedMemory === 0,
  `${misfiredBare + misfiredQuotedMemory} of 6 queries boosted a memory that was not theirs`,
);
// Asserted in the positive because it is the whole reason the docs tell you not
// to quote. If mem0 ever learns to tell two CJK names apart, this goes red and
// the advice — not the code — is what needs revisiting.
check(
  "quoting on both sides still misfires, so the advice not to quote still stands",
  misfiredBothQuoted === 3,
  `${misfiredBothQuoted} of 3 queries boosted an unrelated memory`,
);

await profileRerank(resolveProject(process.env.MEM0_LOCAL_BENCH_ROOT));

if (keep) {
  out("");
  out(`--keep: the fixtures are still in \`${BENCH_REPO.id}\` and \`${QUOTED_REPO.id}\`; run again without it to remove them.`);
} else {
  await wipe(BENCH_REPO);
  await wipe(QUOTED_REPO);
}
out("");
out(
  failures > 0
    ? `${failures} check(s) failed — the identifier rule in wording.mjs no longer describes how retrieval behaves.`
    : `The identifier rule still holds. Done in ${((Date.now() - started) / 1000).toFixed(1)}s.`,
);
process.exitCode = failures > 0 ? 1 : 0;
