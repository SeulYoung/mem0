#!/usr/bin/env node
/**
 * Verifies that mem0's retrieval features are actually wired up through this
 * layer, not just nominally configured. Costs nothing: a stub model stands in
 * for the summarisation call, so writes go down mem0's real extraction path
 * (entity extraction and linking, BM25 lemmatisation, attribution) while the
 * reads go through this layer's own search.
 *
 * What it pins down:
 *   - mem0 fuses three signals (semantic, BM25 keyword, entity boost) and each
 *     one really fires when it should
 *   - the entity store gets built, populated and linked
 *   - our metadata and mem0's `attributedTo` survive a round trip
 *   - the repository lands in mem0's own `agent_id`, and that is what keeps one
 *     repository's memories — and its entities — out of another's results
 *   - reads may cross repositories but writes may not, even when the caller
 *     names a memory by the full uuid a cross-repository read just handed it
 *   - mem0's cross-encoder reranker runs, re-orders, and reports its score, and
 *     it chooses from the wide candidate set rather than from the returned page
 *   - a repeated write is refused twice over: by the hash of its input and by
 *     what it means, the second one loudly enough to name the memory it hit
 *   - an expiry set at write time hides the memory the way mem0 hides one
 *   - a query that can reach none of the ASCII-bound signals says so, and one
 *     that can reach them stays quiet
 */
import { loadConfig } from "../src/config.mjs";
import { createEmbedder } from "../src/embedder.mjs";
import {
  addMemory,
  deleteMemory,
  listMemories,
  memoryConfig,
  queryReachWarning,
  routeConsoleToStderr,
  scopeFilters,
  searchMemories,
  updateMemory,
} from "../src/memory.mjs";
import { rerankerConfig } from "../src/reranker.mjs";

routeConsoleToStderr();

const config = loadConfig();
const out = (line) => process.stdout.write(`${line}\n`);

let failures = 0;
const check = (label, ok, detail) => {
  out(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const repoOne = { id: "retrieval-test-one", name: "retrieval-test-one", root: "C:\\nonexistent\\one" };
const repoTwo = { id: "retrieval-test-two", name: "retrieval-test-two", root: "C:\\nonexistent\\two" };

const IDENTIFIER = "10.BuildPC.bat";
const FACT_ONE = `项目 FTBattle 的构建必须走 ${IDENTIFIER} 脚本，禁止手敲 UBT 命令。`;
const FACT_TWO = `另一个仓库的构建也用 ${IDENTIFIER}，但发布分支叫 release-legacy。`;

/**
 * A model that answers exactly what mem0's extraction prompt asks for. Using
 * mem0's own schema (id + text, optional attributed_to) means the write goes
 * through the same code path a real model would trigger.
 */
function stubModel(text, attributedTo) {
  return {
    model: "stub",
    async invoke() {
      return {
        content: JSON.stringify({ memory: [{ id: "0", text, attributed_to: attributedTo }] }),
      };
    },
  };
}

async function writeViaExtraction(project, text, attributedTo, kind) {
  const { Memory } = await import("mem0ai/oss");
  const memory = new Memory(
    memoryConfig({ config, embedder: createEmbedder(config), llm: stubModel(text, attributedTo) }),
  );
  // Built the way addMemory builds a write: the repository travels in the
  // filters, which is where mem0 picks `agent_id` up from and stamps it on the
  // record it stores.
  return memory.add(`请记住：${text}`, {
    userId: config.userId,
    filters: scopeFilters(config, project, "project"),
    metadata: {
      project_name: project.name,
      kind,
      source: "test:retrieval",
      evidence: "stated",
      confidence: 0.7,
      confidence_reason: "Deterministic extraction fixture.",
    },
    infer: true,
  });
}

async function wipe() {
  for (const project of [repoOne, repoTwo]) {
    // Expired fixtures included, or the one written with an expiry would survive
    // every wipe: it is invisible to an ordinary listing by design.
    for (const record of await listMemories({ project, limit: 200, scope: "project", includeExpired: true })) {
      if (record.project === project.id) await deleteMemory(record.id, project);
    }
  }
}

const signals = (record) => record.scoreDetails ?? {};

const store = (text, extra) =>
  addMemory({ text, project: repoOne, kind: "note", source: "test:retrieval", ...extra });

/**
 * The fixtures only. Reads are scoped to one repository, so in a store used for
 * real this is normally everything that comes back — but a `scope: "all"` read
 * and the reranker's wider candidate set both reach past that, so anything
 * asserting on *which* memories came back has to say which ones are ours.
 */
const mine = (records) => records.filter((record) => record.project === repoOne.id);

/**
 * Reranking is the one retrieval feature whose whole value is in an ordering, so
 * the fixtures are a pair the two stages disagree about: the decoy repeats the
 * query's words, the answer answers the question.
 */
const RERANK_QUERY = "which script has to be used to compile FTBattle";
const RERANK_ANSWER = "Compiling FTBattle goes through the 10.BuildPC.bat wrapper only; hand-typed UBT command lines are rejected in review.";
const RERANK_DECOY = "The office build machine is called BUILD-01, and the build disk in it must never be wiped or reimaged.";

async function checkReranking() {
  if (!rerankerConfig(config)) {
    out("\n   reranker disabled in config — skipping its checks\n");
    return;
  }
  await store(RERANK_ANSWER);
  await store(RERANK_DECOY);

  const ask = (extra) => searchMemories({ query: RERANK_QUERY, project: repoOne, topK: 10, ...extra });
  const fused = await ask({ rerank: false });
  const reranked = await ask({});
  const order = (records) => records.map((r) => `${r.text.slice(0, 22)}…`);
  out(`\n   fused order:    ${JSON.stringify(order(fused))}`);
  out(`   reranked order: ${JSON.stringify(order(reranked))}\n`);

  check(
    "rerankScore reaches the caller",
    reranked.length >= 2 && reranked.every((record) => typeof record.rerankScore === "number"),
    JSON.stringify(reranked.map((r) => r.rerankScore)),
  );
  check(
    "rerank: false really turns it off",
    fused.every((record) => record.rerankScore === undefined),
    JSON.stringify(fused.map((r) => r.rerankScore)),
  );
  check(
    "results come back in the cross-encoder's order",
    reranked.every((record, index) => index === 0 || reranked[index - 1].rerankScore >= record.rerankScore),
  );
  check(
    "the cross-encoder prefers the answer over a memory that merely repeats the query's words",
    mine(reranked)[0]?.text === RERANK_ANSWER,
    `winner: ${mine(reranked)[0]?.text.slice(0, 40)}…`,
  );

  // The point of asking mem0 for a wider candidate set: a single-result search
  // must return the best of everything found, not the best of the one row it was
  // going to return anyway.
  const single = await searchMemories({ query: RERANK_QUERY, project: repoOne, topK: 1 });
  check(
    "a topK=1 search is served from the wide candidate set",
    single.length === 1 && single[0].id === reranked[0].id,
    fused[0]?.id === reranked[0]?.id ? "both stages agreed here, so this only pins the mechanism" : "reranking overturned the fused winner",
  );
}

const DEDUPE_ORIGINAL = "Release tags for FTBattle are cut from the release-legacy branch, never from main.";
const DEDUPE_REWORD = "FTBattle release tags are always cut off the release-legacy branch and never off main.";
const DEDUPE_SIBLING = "FTBattle release notes are written by the producer before the tag is cut, not by engineering.";

async function checkDeduplication() {
  const first = await store(DEDUPE_ORIGINAL);
  check("a new memory is stored", first.length === 1);
  check("the input hash is stamped on it", Boolean(first[0]?.sourceHash), `sourceHash=${first[0]?.sourceHash}`);

  const repeat = await store(DEDUPE_ORIGINAL);
  check("the same input again is refused silently", repeat.length === 0, `${repeat.length} stored`);

  let rejection = null;
  try {
    await store(DEDUPE_REWORD);
  } catch (error) {
    rejection = error.message;
  }
  check(
    "a reworded duplicate is refused, and the message names the memory it hit",
    Boolean(rejection?.includes(first[0].id.slice(0, 8))),
    rejection ?? "it was stored instead",
  );

  const forced = await store(DEDUPE_REWORD, { dedupe: false });
  check("force stores it anyway", forced.length === 1);

  const sibling = await store(DEDUPE_SIBLING);
  check(
    "a different fact about the same subject is not mistaken for a duplicate",
    sibling.length === 1,
    sibling.length === 1 ? "" : "it was refused — the similarity threshold is too low",
  );
}

async function checkExpiryOnWrite() {
  const stored = await store("FTBattle ships on Unreal 5.4 until the engine upgrade lands.", { expiresAt: "2020-01-01" });
  check("a memory can be written with an expiry", stored.length === 1);

  const visible = mine(await listMemories({ project: repoOne, limit: 10, scope: "project" }));
  check("mem0 hides it once the date has passed", visible.length === 0, `${visible.length} still listed`);

  const found = mine(
    await searchMemories({ query: "which engine version does FTBattle ship on", project: repoOne, topK: 5 }),
  );
  check("and keeps it out of search", found.length === 0, `${found.length} still found`);

  const revealed = mine(await listMemories({ project: repoOne, limit: 10, scope: "project", includeExpired: true }));
  check(
    "it is still there to be revived",
    revealed.length === 1 && revealed[0].expiresAt === "2020-01-01",
    `expiresAt=${revealed[0]?.expiresAt}`,
  );
}

/**
 * The guard over the query shape two of the three signals cannot see. Pure, so
 * it needs no fixtures: what it pins down is where the line falls, because the
 * warning is worth nothing if it also fires on queries that do reach the
 * keyword index — an agent that learns to ignore it has lost the one case it
 * exists for.
 */
function checkQueryReach() {
  const warned = (query) => queryReachWarning(query) !== null;
  check("a CJK-only query is called out", warned("空投宝箱是怎么生成的"));
  check("so is one that is only an identifier", warned("重回房间"));
  check("punctuation does not rescue it", warned("空投宝箱？"));
  // The fix the warning asks for has to switch it off, or it is telling the
  // caller to do something that changes nothing.
  check("one English word is enough to reach the keyword index", !warned("空投宝箱 chest"));
  check("an ordinary English query is left alone", !warned("how is the airdrop chest spawned"));
  // Digits are lemmatised alongside letters (/[a-z0-9]+/), so a version number
  // or an error code is a real keyword even with no prose around it.
  check("a bare number is a keyword, not a dead query", !warned("5.4"));
  check("an empty query has nothing to warn about", !warned("   "));
}

try {
  await wipe();

  const written = await writeViaExtraction(repoOne, FACT_ONE, "user", "convention");
  const stored = (written?.results ?? []).map((item) => item.id);
  check("extraction path stored the fact", stored.length === 1, `${stored.length} record(s)`);

  const listed = mine(await listMemories({ project: repoOne, limit: 10, scope: "project" }));
  check(
    "our metadata survives the extraction path",
    listed.length === 1 &&
      listed[0].kind === "convention" &&
      listed[0].source === "test:retrieval" &&
      listed[0].confidence === 0.7 &&
      listed[0].evidence === "stated",
    JSON.stringify(
      listed.map((r) => ({
        project: r.project,
        kind: r.kind,
        source: r.source,
        evidence: r.evidence,
        confidence: r.confidence,
      })),
    ),
  );

  // mem0 returns attribution outside `metadata`; this layer used to drop it.
  const byIdentifier = mine(
    await searchMemories({
      query: `${IDENTIFIER} 怎么用`,
      project: repoOne,
      topK: 5,
      explain: true,
    }),
  );
  check("search finds the memory", byIdentifier.length >= 1);
  check(
    "mem0's user/assistant attribution reaches the caller",
    byIdentifier[0]?.attributedTo === "user",
    `attributedTo=${byIdentifier[0]?.attributedTo ?? "(dropped)"}`,
  );

  const hit = signals(byIdentifier[0]);
  out(`\n   signals for an identifier query: ${JSON.stringify(hit)}\n`);
  check("semantic signal contributes", (hit.semanticScore ?? 0) > 0, `semanticScore=${hit.semanticScore}`);
  check(
    "BM25 keyword signal contributes",
    (hit.bm25Score ?? 0) > 0,
    `bm25Score=${hit.bm25Score} (mem0 lemmatises to ASCII tokens, so identifiers are what BM25 can see)`,
  );
  check(
    "entity boost contributes — entity store is built, populated and linked",
    (hit.entityBoost ?? 0) > 0,
    `entityBoost=${hit.entityBoost}`,
  );
  check(
    "all three signals are counted in the normaliser",
    Math.abs((hit.maxPossibleScore ?? 0) - 2.5) < 1e-9,
    `maxPossibleScore=${hit.maxPossibleScore} (1 semantic + 1 bm25 + 0.5 entity)`,
  );

  // A query with no ASCII at all: only the semantic signal can match, because
  // mem0's BM25 lemmatiser and entity extractor both work on ASCII tokens.
  const inChinese = mine(
    await searchMemories({
      query: "构建这个项目有什么规定",
      project: repoOne,
      topK: 5,
      explain: true,
    }),
  );
  const chineseHit = signals(inChinese[0]);
  out(`\n   signals for a Chinese-only query: ${JSON.stringify(chineseHit)}\n`);
  check(
    "a Chinese-only query still retrieves by meaning",
    inChinese.length >= 1 && (chineseHit.semanticScore ?? 0) > 0,
    `semanticScore=${chineseHit.semanticScore}`,
  );

  // Same identifier in another repository. mem0 scopes the entity index by the
  // same `agent_id` as the memories, so the two repositories now have an entity
  // row each for one identifier — and neither search may see the other's.
  await writeViaExtraction(repoTwo, FACT_TWO, "user", "convention");
  const afterNeighbour = await searchMemories({
    query: `${IDENTIFIER} 怎么用`,
    project: repoOne,
    topK: 10,
    explain: true,
  });
  check(
    "the other repository's memory does not reach these results",
    afterNeighbour.every((record) => record.project !== repoTwo.id),
    JSON.stringify(afterNeighbour.map((r) => r.project)),
  );
  check(
    "the entity signal still fires once two repositories share an identifier",
    (signals(mine(afterNeighbour)[0]).entityBoost ?? 0) > 0,
    `entityBoost=${signals(mine(afterNeighbour)[0]).entityBoost}`,
  );

  // Both fixtures must show up; anything else in the store legitimately may too,
  // so this asserts presence rather than an exact project count.
  const searchAll = await searchMemories({ query: IDENTIFIER, project: repoOne, topK: 25, scope: "all" });
  const projectsFound = new Set(searchAll.map((record) => record.project));
  check(
    "an explicit cross-repository search does see both fixtures",
    projectsFound.has(repoOne.id) && projectsFound.has(repoTwo.id),
    JSON.stringify([...projectsFound]),
  );

  const capped = await searchMemories({ query: IDENTIFIER, project: repoOne, topK: 1, scope: "all" });
  check("topK is honoured", capped.length === 1, `${capped.length} record(s)`);

  // A cross-repository read is exactly where one repository learns another's
  // full uuid, so the write paths have to re-check ownership rather than trust
  // a well-formed id. Short ids were always scoped; uuids used to be waved past.
  const neighbour = searchAll.find((record) => record.project === repoTwo.id);
  const refused = async (label, run) => {
    try {
      await run();
      check(label, false, "the write went through");
    } catch (error) {
      check(label, /belongs to another repository/.test(error.message), error.message);
    }
  };
  await refused("a full uuid from another repository cannot be rewritten", () =>
    updateMemory({ id: neighbour.id, project: repoOne, text: "Rewritten from the wrong repository." }),
  );
  await refused("a full uuid from another repository cannot be deleted", () =>
    deleteMemory(neighbour.id, repoOne),
  );
  const survivor = (await listMemories({ project: repoTwo, limit: 10, scope: "project" })).find(
    (record) => record.id === neighbour.id,
  );
  check("the other repository's memory is untouched", survivor?.text === neighbour.text, survivor?.text);

  // Same memory, named from the repository that owns it: the ban is on reaching
  // across, not on editing. The edit must also leave the memory where it is —
  // mem0 merges an update over the existing payload and strips identity keys out
  // of the metadata it is handed, which is what keeps `agent_id` put, and is
  // also why re-keying a repository has to be a payload-level job.
  const edited = await updateMemory({
    id: neighbour.id.slice(0, 8),
    project: repoTwo,
    text: `Rewritten by the repository that owns it, still about ${IDENTIFIER}.`,
  });
  check(
    "its owner can edit it, and the edit keeps the id, the date and the repository",
    edited.id === neighbour.id && edited.project === repoTwo.id && edited.createdAt === neighbour.createdAt,
    `project=${edited.project} id=${edited.id.slice(0, 8)}`,
  );

  await wipe();
  await checkReranking();
  await wipe();
  await checkDeduplication();
  await wipe();
  await checkExpiryOnWrite();
  checkQueryReach();

  out(failures === 0 ? "\nRetrieval features verified." : `\n${failures} check(s) failed.`);
} finally {
  // The fixtures are deleted; the messages mem0 replays are not. They live in
  // the shared history database under this test's own `agent_id`, where mem0
  // keeps the ten newest per scope and no repository can see another's.
  await wipe();
}

process.exit(failures === 0 ? 0 : 1);
