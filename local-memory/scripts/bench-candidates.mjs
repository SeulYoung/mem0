#!/usr/bin/env node
/**
 * How wide does the reranker's candidate set have to be?
 *
 * mem0 hands the cross-encoder exactly the rows it was asked to return, so the
 * pool is `reranker.candidates` — and anything the *fused* stage ranked below
 * that never gets a second look. Two things push a good answer down in the fused
 * stage: verbatim writes carry no entity rows (mem0 only links entities on the
 * extraction path), so they compete without the third signal, and BM25 rewards a
 * memory that merely repeats the query's words.
 *
 * This measures the pool size at which the winner stops changing, against the
 * real store, and what each width costs in time. Read-only.
 *
 * The conclusion expires on its own: a winner that sits at a fixed percentile of
 * the store drops past a fixed pool as the store grows. So the verdict at the
 * end is about the width the layer actually uses — how many queries it already
 * gets wrong, and how many places of headroom are left before it does.
 *
 * Usage: node scripts/bench-candidates.mjs [pool sizes...]
 *        MEM0_LOCAL_BENCH_ROOT=D:\some\repo node scripts/bench-candidates.mjs
 */
import { loadConfig } from "../src/config.mjs";
import { listMemories, openMemory, routeConsoleToStderr, scopeFilters } from "../src/memory.mjs";
import { resolveProject } from "../src/project.mjs";

routeConsoleToStderr();

const out = (line) => process.stdout.write(`${line}\n`);
const config = loadConfig();
const project = resolveProject(process.env.MEM0_LOCAL_BENCH_ROOT);

const QUERIES = [
  "how many memories does a search return by default",
  "why are memories stored in English",
  "how do I change which repository a memory belongs to",
  "what happens to expired memories",
  "which model does summarisation use and how is it called",
  "how does the watchdog detect that the memory server is broken",
  "why does getAll ask for the whole collection",
  "how is a duplicate memory detected",
  "what does the reranker do to the ranking",
  "where is the data stored on disk",
  "how do I review what a mem0 release changed",
  "which node runtime starts the MCP server",
];

/**
 * What `searchMemories` actually asks mem0 for. Comparing anything else against
 * the whole store answers a question nobody has: the only pool that decides
 * whether `reranker.candidates` needs widening is the one the layer really uses.
 */
const CONFIGURED = Math.max((config.search?.topK ?? 6) * 4, config.reranker?.candidates ?? 25);

const POOLS =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2).map(Number)
    : [...new Set([6, CONFIGURED, 60])].sort((a, b) => a - b).concat(0);

const { memory } = await openMemory();
const filters = scopeFilters(config, project, "project");
const total = (await listMemories({ project, limit: 100000, scope: "project" })).length;
const label = (pool) => (pool === 0 ? `all (${total})` : String(pool));

async function ranked(query, pool, rerank) {
  const started = Date.now();
  const result = await memory.search(query, {
    filters,
    topK: pool === 0 ? total : pool,
    ...(rerank ? { rerank: true } : {}),
  });
  return { ids: (result?.results ?? []).map((item) => item.id), ms: Date.now() - started };
}

out(`store: ${total} memories in ${project.id}`);
out(`pools: ${POOLS.map(label).join(", ")}   (searchMemories asks for ${CONFIGURED})\n`);

// One untimed search first: the model loads lazily, so without this the very
// first pool absorbs the load and the timing column comes out non-monotonic.
await ranked(QUERIES[0], POOLS[0], true);

const timings = new Map(POOLS.map((pool) => [pool, []]));
let changedByWidening = 0;
let missedByConfigured = 0;
let worstFusedRank = 0;

for (const query of QUERIES) {
  const fused = await ranked(query, 0, false);
  const winners = [];
  for (const pool of POOLS) {
    const { ids, ms } = await ranked(query, pool, true);
    timings.get(pool).push(ms);
    winners.push({ pool, id: ids[0] ?? null });
  }

  const widest = winners.at(-1).id;
  // Where the best answer sat before the cross-encoder saw it: the pool has to
  // reach at least this far or the winner is not even a candidate.
  const fusedRank = widest ? fused.ids.indexOf(widest) + 1 : 0;
  const narrowest = winners[0].id;
  if (narrowest !== widest) changedByWidening += 1;
  const atConfigured = winners.find((w) => w.pool === CONFIGURED);
  if (atConfigured && atConfigured.id !== widest) missedByConfigured += 1;
  if (fusedRank > worstFusedRank) worstFusedRank = fusedRank;

  const text = new Map(
    (await listMemories({ project, limit: 100000, scope: "project" }))
      .filter((record) => record.id === widest)
      .map((record) => [record.id, record]),
  ).get(widest);

  out(`? ${query}`);
  out(`  fused rank of the final winner: ${fusedRank || "not found"} of ${fused.ids.length}`);
  out(`  winner per pool: ${winners.map((w) => `${label(w.pool)}=${(w.id ?? "none").slice(0, 8)}`).join("  ")}`);
  out(`  winner: [${text?.kind ?? "?"}/${text?.source ?? "?"}] ${(text?.text ?? "").slice(0, 90)}`);
  out("");
}

out(`queries whose top result changed between pool ${label(POOLS[0])} and pool ${label(POOLS.at(-1))}: ${changedByWidening} of ${QUERIES.length}`);
out("");
// The verdict. `missedByConfigured` going above 0 means the pool is already too
// narrow; the headroom says how much room is left before it does, and shrinks
// on its own as the store grows even when nothing else changes.
out(`VERDICT  pool ${CONFIGURED} disagrees with the whole store on ${missedByConfigured} of ${QUERIES.length} queries`);
out(
  `         deepest winner sat at fused rank ${worstFusedRank} of ${total}` +
    ` — ${CONFIGURED - worstFusedRank} place(s) of headroom under the configured pool`,
);
if (missedByConfigured > 0) {
  out(`         → widen reranker.candidates past ${worstFusedRank}.`);
} else if (CONFIGURED - worstFusedRank <= 5) {
  out(`         → still correct, but the margin is thin. Re-run after the next batch of memories.`);
}
out("");
for (const pool of POOLS) {
  const list = [...timings.get(pool)].sort((a, b) => a - b);
  // Median, not mean: one stray GC or disk hit is enough to make a mean claim
  // that a wider pool is faster than a narrower one.
  const median = list[Math.floor(list.length / 2)];
  out(`  pool ${label(pool).padEnd(9)} median ${String(median).padStart(5)}ms   max ${Math.max(...list)}ms`);
}
