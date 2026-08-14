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
 * Usage: node scripts/bench-candidates.mjs [pool sizes...]
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

const POOLS = process.argv.slice(2).length > 0 ? process.argv.slice(2).map(Number) : [6, 25, 60, 0];

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
out(`pools: ${POOLS.map(label).join(", ")}\n`);

const timings = new Map(POOLS.map((pool) => [pool, []]));
let changedByWidening = 0;

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
for (const pool of POOLS) {
  const list = timings.get(pool);
  const mean = Math.round(list.reduce((sum, ms) => sum + ms, 0) / list.length);
  out(`  pool ${label(pool).padEnd(9)} mean ${String(mean).padStart(5)}ms   max ${Math.max(...list)}ms`);
}
