import crypto from "node:crypto";
import fs from "node:fs";

import { DEFAULT_CONFIG, loadConfig, rememberDimension } from "./config.mjs";
import { createEmbedder } from "./embedder.mjs";
import { createLlm, resolveApiKey } from "./llm.mjs";
import { PATHS, ensureDirs, log } from "./paths.mjs";
import { rerankerConfig, rerankerReady } from "./reranker.mjs";

/**
 * mem0 (and some of its providers) occasionally write to stdout via
 * console.log/debug/info. On the MCP stdio channel that would corrupt the
 * JSON-RPC stream, so every entry point routes those to stderr first.
 */
export function routeConsoleToStderr() {
  const write = (...args) => process.stderr.write(`${args.map(String).join(" ")}\n`);
  console.log = write;
  console.info = write;
  console.debug = write;
}

/**
 * Several Cursor windows (and their hooks) touch the same SQLite files, so put
 * them in WAL mode: readers stop blocking the writer. The setting is stored in
 * the database file itself, so doing it best-effort on every open is enough.
 */
async function setWal(...files) {
  const { default: Database } = await import("better-sqlite3");
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) continue;
      const db = new Database(file);
      db.pragma("journal_mode = WAL");
      db.close();
    } catch (error) {
      log("sqlite", `WAL setup skipped for ${file}: ${error.message}`);
    }
  }
}

/**
 * The `MemoryConfig` this layer runs on. Exported so tests can build an
 * identical instance with a stub model and assert on what mem0 would send.
 */
export function memoryConfig({ config, embedder, llm, historyDbPath = PATHS.historyDb }) {
  const reranker = rerankerConfig(config);
  return {
    embedder: { provider: "langchain", config: { model: embedder } },
    vectorStore: {
      provider: "memory",
      config: {
        collectionName: "mem0_local",
        dbPath: PATHS.vectorDb,
        // Known dimension keeps list-only calls from loading the ONNX model.
        ...(config.embedder?.dimension ? { dimension: config.embedder.dimension } : {}),
      },
    },
    llm: llm
      ? { provider: "langchain", config: { model: llm } }
      : {
          provider: "openai",
          config: {
            // Never called unless llm.enabled; the OpenAI SDK just refuses to build without a key.
            // `env:NAME` means the same thing here as it does for the CLI bridge.
            apiKey: resolveApiKey(config.llm) || "not-needed",
            model: config.llm?.model || "gpt-4o-mini",
            ...(config.llm?.baseURL ? { openaiBaseUrl: config.llm.baseURL, baseURL: config.llm.baseURL } : {}),
          },
        },
    historyStore: { provider: "sqlite", config: { historyDbPath } },
    // Building the reranker here costs nothing: mem0 constructs it eagerly but
    // the cross-encoder library and its model are only loaded on the first
    // search that actually asks to rerank.
    ...(reranker ? { reranker } : {}),
    ...(config.llm?.customInstructions ? { customInstructions: config.llm.customInstructions } : {}),
  };
}

let base;
let instance;

/** Everything that does not depend on which repository we are working in. */
async function openBase() {
  if (base) return base;
  ensureDirs();
  // Before any Memory is constructed, while nothing else holds the files:
  // switching journal mode needs exclusive access.
  await setWal(PATHS.vectorDb, PATHS.vectorDb.replace(/\.db$/, "_entities.db"), PATHS.historyDb);
  // loadConfig() sets MEM0_TELEMETRY, and mem0 reads it once at module load —
  // so the import in openMemory must stay dynamic and stay after this line.
  const config = loadConfig();
  base = {
    config,
    embedder: createEmbedder(config),
    // A bridge object means the model is reached through something that is not
    // an HTTP endpoint (the Cursor CLI); mem0's `langchain` provider is the
    // extension point for exactly that. Anything else stays on mem0's own client.
    llm: createLlm(config),
    llmEnabled: Boolean(config.llm?.enabled),
  };
  return base;
}

/**
 * The one mem0 instance, shared by every repository.
 *
 * Which repository a call belongs to travels in the `agent_id` filter it passes,
 * not in which instance it goes through — see `scopeFilters`. That is what
 * allows a single instance and a single history database: mem0 keys the messages
 * it replays into the extraction prompt (`## Last k Messages`) on the same
 * field. While a repository was a metadata key of ours, mem0 could not see it,
 * so isolation had to be bought with one instance and one history file each.
 */
export async function openMemory() {
  const shared = await openBase();
  if (!instance) {
    const { Memory } = await import("mem0ai/oss");
    instance = new Memory(memoryConfig(shared));
  }
  return { ...shared, memory: instance };
}

/** Probe the embedder once and cache the dimension in config.json. */
export async function detectDimension() {
  const { config, embedder } = await openBase();
  if (config.embedder?.dimension) return config.embedder.dimension;
  const vector = await embedder.embedQuery("dimension probe");
  rememberDimension(vector.length);
  config.embedder.dimension = vector.length;
  return vector.length;
}

function toRecord(item) {
  const metadata = item.metadata ?? {};
  return {
    id: item.id,
    text: item.memory,
    // mem0 returns `agent_id` outside `metadata`, like the other identity keys.
    // The fallback reads a record written before repositories moved into that
    // field; those are invisible to every scoped read, so this is what lets
    // `scope: "all"` and the migration script still account for them.
    project: item.agent_id ?? metadata.project ?? null,
    projectName: metadata.project_name ?? null,
    kind: metadata.kind ?? null,
    source: metadata.source ?? null,
    sourceHash: metadata.source_hash ?? null,
    // mem0 stamps both itself; we never write a timestamp of our own.
    createdAt: item.createdAt ?? null,
    // Only on a memory that has been rewritten: `createMemory` sets no
    // `updatedAt`, `updateMemory` does. Carrying it matters because an edit
    // deliberately keeps the original `createdAt`, so a corrected memory reads
    // as older than the fact it now states — and how stale a memory looks is
    // most of how anyone decides whether to trust it.
    ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
    score: item.score,
    // Only present once someone sets one. mem0 hides expired memories from
    // search and getAll on its own, so this is the one place they are visible.
    ...(metadata.expiration_date ? { expiresAt: metadata.expiration_date } : {}),
    // mem0 returns these three outside `metadata`: who the fact is about (set
    // when the model attributes it), the cross-encoder's own score once the
    // results have been reranked, and with explain on the per-signal breakdown.
    // Passing them through keeps mem0's features visible.
    ...(item.attributedTo ? { attributedTo: item.attributedTo } : {}),
    ...(item.rerankScore === undefined ? {} : { rerankScore: item.rerankScore }),
    ...(item.score_details ? { scoreDetails: item.score_details } : {}),
  };
}

/**
 * Scope a query to one repository, as mem0's own `agent_id`.
 *
 * `agent_id` is the field mem0 itself means "which workspace this belongs to"
 * by, so naming the repository that way puts the boundary inside every mechanism
 * mem0 has: the vector filter, the entity index behind the entity boost, and the
 * session scope its message replay is keyed on. The price is that a memory
 * cannot be shared between repositories — an identity key is fixed at write
 * time, and mem0 takes one value per query, not a list.
 *
 * Handed to mem0 rather than applied afterwards so it takes effect inside the
 * store, before top-k truncation. Also used on writes, where mem0 searches
 * existing memories to decide what is new.
 *
 * `user_id` stays even where `agent_id` alone would scope the query: mem0 reads
 * `agent_id` without `user_id` as "these memories belong to an agent" and appends
 * AGENT_CONTEXT_SUFFIX to its extraction prompt, which reframes every fact as
 * agent knowledge ("Agent was informed that ..."). `test-llm.mjs` asserts it
 * stays out.
 */
export function scopeFilters(config, project, scope) {
  const filters = { user_id: config.userId };
  if (scope === "all") return filters;
  if (!project?.id) throw new Error("A repository is required to scope this call.");
  filters.agent_id = project.id;
  return filters;
}

/** Second line of defence in case a future mem0 changes filter semantics. */
function visibleIn(record, projectId, scope) {
  if (scope === "all") return true;
  return record.project === projectId;
}

/**
 * The categories a caller may write, each with the test that tells it from its
 * neighbours. `inject.kinds` selects from these.
 *
 * The tests are not decoration. mem0's OSS build has no category field at all —
 * categories are a Platform feature whose catalog a hosted classifier assigns,
 * and whose vocabulary (personal_details, family, sports, food) would put every
 * memory in a code repository under `technology` — so this catalog is ours to
 * define, and an agent picks from it with nothing but these words to go on. A
 * label two sessions sort the same fact into differently is worth nothing.
 *
 * `config.capture.kind` ("prompt") is a seventh value on purpose, written only
 * by the capture hook and left out of this catalog so no agent files a curated
 * memory under it. `assertKind` accepts it; the tool schemas do not offer it.
 */
export const KIND_GUIDE = {
  preference:
    "A person's taste, independent of any repository: which language to answer in, which tools, how to write a commit. The subject is a human.",
  convention:
    "A rule this repository expects you to follow. Reads naturally as an instruction — do it this way, never that way.",
  decision:
    "A choice already made, together with the reason. Names the option it beat, or why the obvious one was rejected.",
  gotcha:
    "Behaviour that bites silently: not knowing it gets you code that looks right and is wrong, with no error to warn you. Say what goes wrong.",
  fact: "A measurement, or verified state of something outside your control. Nothing to obey and no symptom to avoid — a number or a shape you would otherwise have to work out again.",
  context:
    "Why one piece of work is happening and what it covers: the requirement behind it, the files and assets in scope, a design agreed but not yet built. Requires an expiresAt — it is true for a stretch of work, not indefinitely.",
  note: "None of the above, and still worth having next session. The fallback, and rarely the right answer.",
};

export const KINDS = Object.keys(KIND_GUIDE);

/**
 * Kinds that are refused without an expiry date.
 *
 * `context` exists because the catalog had a real gap and `note` was absorbing
 * it: task background is not a taste, a rule, a reason, a symptom or a
 * measurement, yet it is the first thing a session resuming that work wants.
 * What kept it out was that it stops being true — so the expiry is the whole
 * reason the kind can exist, and asking for it politely would leave the store
 * accumulating permanent records of finished weeks. Enforced here rather than
 * in the schema because the CLI writes memories too.
 */
const EXPIRING_KINDS = new Set(["context"]);

function assertExpiry(kind, expiresAt) {
  if (!EXPIRING_KINDS.has(kind) || expiresAt) return;
  throw new Error(
    `A "${kind}" memory needs an expiresAt (YYYY-MM-DD): it records work in flight, and nothing else in this store ever removes it.`,
  );
}

/**
 * mem0 stores whatever kind it is handed, so a typo is not an error there — the
 * memory is simply never injected again, because injection filters on
 * `inject.kinds`. Silent for the rest of the memory's life; worth a throw here.
 */
function assertKind(kind, config) {
  const allowed = [...KINDS, config.capture?.kind ?? "prompt"];
  if (!allowed.includes(kind)) throw new Error(`Unknown kind "${kind}". Use one of: ${allowed.join(", ")}.`);
}

/**
 * Find the memory a given input produced, by the hash we stamped on it. mem0
 * applies filters inside the store, and arbitrary metadata keys work there
 * alongside its own identity keys, so this is a keyed lookup and not a scan of
 * the whole collection.
 *
 * Expired memories stay out on purpose: an expired memory is invisible
 * everywhere else, so letting one block a rewrite would make the input
 * permanently unstorable.
 */
async function findByInputHash(memory, filters, hash) {
  const raw = await memory.getAll({ filters: { ...filters, source_hash: hash }, topK: 2 });
  return (raw?.results ?? []).map(toRecord);
}

/**
 * How many of mem0's hits to consider when asking whether an existing memory
 * already says this. More than one because mem0 orders by its *fused* score:
 * a memory that shares the wording, or an entity, can outrank the one with the
 * highest cosine, and the top row alone would then answer a different question
 * than the one being asked. mem0 scans at least 60 rows for any small topK, so
 * looking at ten of them costs nothing beyond the rows it already scored.
 */
const DEDUPE_WINDOW = 10;

/**
 * The nearest existing memory, if it is close enough to count as a restatement.
 *
 * mem0 does this itself on its extraction path, where the model is shown the
 * neighbouring memories and told to only report what is new. The verbatim path
 * has no such step, so this asks the same question the only way it can be asked
 * without a model: embed the text and look at what it lands on top of.
 */
async function findNearDuplicate(memory, filters, text, similarity) {
  const raw = await memory.search(text, { filters, topK: DEDUPE_WINDOW, explain: true });
  // `semanticScore` is the plain cosine between the two embeddings, and the only
  // figure that answers "do these two texts say the same thing". The fused
  // `score` beside it cannot: mem0 divides it by a factor that depends on which
  // signals fired anywhere in the candidate set, so it moves for reasons that
  // have nothing to do with this pair of texts — which is also why the nearest
  // neighbour has to be picked out of the list rather than read off the top.
  let nearest = null;
  for (const hit of raw?.results ?? []) {
    const cosine = hit?.score_details?.semanticScore;
    if (typeof cosine !== "number") continue;
    if (!nearest || cosine > nearest.similarity) nearest = { record: toRecord(hit), similarity: cosine };
  }
  if (!nearest || nearest.similarity < similarity) return null;
  return nearest;
}

export async function addMemory({
  text,
  /**
   * The conversation `text` came out of, as mem0's own `Message[]`. Used on the
   * extraction path only, where mem0 renders it as `role: content` lines and lets
   * the model mine facts out of both sides. Ignored everywhere else, because the
   * verbatim path stores one memory *per message* — a whole agent reply would
   * land in the store as a memory of its own.
   */
  messages = null,
  project,
  kind = "note",
  source = "mcp",
  infer = false,
  expiresAt = null,
  dedupeKey = null,
  dedupe = true,
}) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) throw new Error("Refusing to store an empty memory.");
  if (!project?.id) throw new Error("A repository is required to store a memory.");

  const { memory, config } = await openMemory();
  assertKind(kind, config);
  assertExpiry(kind, expiresAt);
  const filters = scopeFilters(config, project, "project");
  const wantInfer = Boolean(infer) && Boolean(config.llm?.enabled);

  // Stamped on every record, and hashed from the *input* rather than from what
  // ends up stored: with the summarisation model the stored text no longer
  // resembles the input, so comparing texts would let a resubmitted prompt pay
  // for a second extraction.
  const inputHash = dedupeKey ?? crypto.createHash("md5").update(trimmed).digest("hex");

  // mem0 compares memories only on its extraction path, where the model is shown
  // the neighbours and told to report just what is new. Every other path goes
  // straight to `createMemory`, which stores whatever it is handed — so the two
  // checks below are all that stands between a repeated write and a second copy
  // of the same fact.
  //
  // This one first, and on its own, because it is the only one that costs
  // nothing: a keyed lookup, no embedding, so a replayed capture is turned away
  // without loading the model.
  if (dedupe) {
    const [duplicate] = await findByInputHash(memory, filters, inputHash);
    // Silent: this exact input has already been through here, so it is a
    // replayed capture or a repeated command, with nothing for anyone to decide.
    if (duplicate) {
      log("memory", `skipped duplicate input (id=${duplicate.id}) source=${source}`);
      return [];
    }
  }

  await detectDimension();

  // Verbatim path only. On the extraction path mem0 already does this, and better
  // — it compares facts rather than wording — so running ours there would reject
  // passages mem0 would have mined a genuinely new fact out of.
  if (dedupe && !wantInfer) {
    const near = await findNearDuplicate(memory, filters, trimmed, config.dedupe?.similarity ?? 0.92);
    // Loud, unlike the hash case: the caller wrote something new that an existing
    // memory already says, and only the caller can decide between rewriting that
    // memory and insisting the two are different facts.
    if (near) {
      throw new Error(
        `Memory ${near.record.id.slice(0, 8)} already says this (similarity ${near.similarity.toFixed(2)}): "${near.record.text.slice(0, 160)}". Update that one if your version is better, or store this anyway with force.`,
      );
    }
  }

  const options = {
    userId: config.userId,
    // Scope what mem0 compares against, and stamp the repository on the record:
    // mem0 copies the identity keys out of `filters` onto the payload it writes,
    // so `agent_id` is set by the same object that scopes the write. Which
    // matters most on the extraction path, where mem0 searches existing
    // memories and hands the top hits to the model to decide what is genuinely
    // new — unscoped, a memory from another repository could make it drop a fact
    // this repository does not have.
    filters,
    metadata: {
      // Display only, and deliberately not the id: every clone of a repository
      // has the same folder name, so a name is not something to scope by.
      project_name: project.name,
      kind,
      source,
      source_hash: inputHash,
    },
    // mem0 validates the YYYY-MM-DD shape and stores it as `expiration_date`,
    // then hides the memory from search and getAll once the date has passed.
    ...(expiresAt ? { expirationDate: expiresAt } : {}),
  };

  let result;
  let inferred = wantInfer;
  const input = wantInfer && Array.isArray(messages) && messages.length > 0 ? messages : trimmed;
  try {
    result = await memory.add(input, { ...options, infer: wantInfer });
  } catch (error) {
    if (!wantInfer) throw error;
    // The model is optional infrastructure; the memory is not. Keep the text.
    log("memory", `infer failed, storing verbatim: ${error.message}`);
    inferred = false;
    result = await memory.add(trimmed, { ...options, infer: false });
  }

  // mem0 does not echo metadata back on writes (only on reads), so a caller
  // would see nulls for values we just supplied. Fill those in from what was
  // written — never overriding anything mem0 did return.
  const stored = (result?.results ?? []).map((item) => {
    const record = toRecord(item);
    for (const [key, value] of Object.entries({
      project: project.id,
      projectName: options.metadata.project_name,
      kind: options.metadata.kind,
      source: options.metadata.source,
      sourceHash: options.metadata.source_hash ?? null,
    })) {
      record[key] ??= value;
    }
    return record;
  });
  log("memory", `add project=${project.id} kind=${kind} source=${source} infer=${inferred} stored=${stored.length}`);
  return stored;
}

/**
 * The one query shape this store cannot answer, named at the moment it is asked.
 *
 * Two of mem0's three signals are ASCII-bound: `lemmatizeForBm25` keeps only
 * `/[a-z0-9]+/g`, and every entity extractor needs an ASCII letter or a quote.
 * A query holding neither a Latin letter nor a digit therefore reaches the
 * embedding model alone — an English model, scoring text it was never trained
 * on. Measured against 45 real memories: two unrelated CJK queries both
 * returned the memory holding the most Chinese characters, because "this text
 * is Chinese" is most of what such an embedding encodes.
 *
 * A warning rather than a refusal. The ranking is arbitrary, not empty, and
 * only the caller can tell whether the top hit happens to be the right one —
 * what it must not do is arrive looking like an ordinary result set. The fix is
 * the caller's too, and it is cheap: `ENGLISH_ONLY` means the memory being
 * looked for is in English, so the query has an English form that works.
 *
 * Quoted CJK is deliberately not exempted, even though `extractQuoted` is the
 * one extractor that accepts it. That route does fire, but it was measured to
 * hand two unrelated queries the same boost profile, so reaching it changes
 * nothing the caller should do differently.
 */
export function queryReachWarning(query) {
  const text = String(query ?? "").trim();
  if (!text || /[a-z0-9]/i.test(text)) return null;
  return "This query has no Latin letters or digits, so mem0's keyword index and entity extractors both saw nothing and only the embedding model ran. That model is English-only, so it ranked these memories by how much non-English text they hold rather than by what they say. Treat the order as arbitrary and search again in English, using the words the memory itself would use.";
}

export async function searchMemories({
  query,
  project,
  // Null rather than a number: how many memories a search returns is a
  // configured policy (`search.topK`), and only a caller that says otherwise —
  // the tool's own argument, `--top` — overrides it.
  topK = null,
  scope = "project",
  kind = null,
  explain = false,
  rerank = null,
  threshold = null,
}) {
  const { memory, config } = await openMemory();
  await detectDimension();
  if (kind) assertKind(kind, config);

  const limit = topK ?? config.search?.topK ?? DEFAULT_CONFIG.search.topK;

  // Rerank a wider set than the caller asked for: reranking only re-orders what
  // the first stage found, so handing it exactly topK reranks the list we were
  // going to return anyway. The window, and the factor it grows by, are
  // `reranker.candidates`.
  const wantRerank = rerank ?? Boolean(rerankerConfig(config));
  const reranking = wantRerank && (await rerankerReady());
  const candidates = reranking ? Math.max(limit * 4, config.reranker?.candidates ?? 25) : limit;
  const floor = threshold ?? config.search?.threshold;

  // `kind` rides along as an ordinary payload filter rather than through
  // `scopeFilters`, whose job is which repository a query belongs to. mem0 spreads
  // caller filters into the store's own filter object and matches any key against
  // the flat payload, and `add` writes metadata flat (`{...metadata, data, ...}`),
  // so `kind` is a top-level key there. The filter therefore applies inside the
  // store, before top-k truncation, and to the keyword pass as well as the
  // semantic one. mem0 rebuilds the entity-store filter from `user_id` /
  // `agent_id` / `run_id` alone, so the entity boost keeps working.
  const filters = scopeFilters(config, project, scope);
  if (kind) filters.kind = kind;

  const raw = await memory.search(String(query ?? "").trim(), {
    filters,
    topK: candidates,
    // mem0 fuses three signals (semantic, BM25 keyword, entity boost); with
    // explain on it reports each one's contribution per result.
    ...(explain ? { explain: true } : {}),
    ...(reranking ? { rerank: true } : {}),
    ...(typeof floor === "number" ? { threshold: floor } : {}),
  });

  return (raw?.results ?? [])
    .map(toRecord)
    .filter((record) => visibleIn(record, project.id, scope))
    .slice(0, limit);
}

/**
 * Every read here asks mem0 for the whole collection and narrows it ourselves.
 * That is not laziness: mem0's `getAll` truncates with `slice(0, topK)` over
 * rows the store returns in *insertion* order — `SELECT * FROM vectors` with no
 * ORDER BY over a rowid table — so any topK below the collection size silently
 * pins every caller to the oldest memories, and the newest ones stop being
 * injected, stop blocking duplicates and stop being addressable by short id.
 * The scan happens either way, so the only cost of asking for everything is the
 * slice; the ordering callers actually want is applied below.
 */
const STORE_SCAN_LIMIT = 100000;

/**
 * `includeExpired` is mem0's own `showExpired`. Off by default so an expired
 * memory really does disappear, but reachable, because otherwise setting an
 * expiry would be irreversible: an expired record is invisible to listing and
 * search alike, and nothing could name it again without its full uuid.
 */
export async function listMemories({ project, limit = 10, scope = "project", includeExpired = false }) {
  const { memory, config } = await openMemory();

  const raw = await memory.getAll({
    filters: scopeFilters(config, project, scope),
    topK: STORE_SCAN_LIMIT,
    ...(includeExpired ? { showExpired: true } : {}),
  });
  return (raw?.results ?? [])
    .map(toRecord)
    .filter((record) => visibleIn(record, project.id, scope))
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))
    .slice(0, limit);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Resolve a caller-supplied id to the memory it names, refusing anything this
 * repository cannot already see.
 *
 * Short ids matter because they are the only ones an agent normally has: the
 * session injection lists memories as `(id: 1223f031)` and the CLI prints eight
 * characters too, so insisting on the full uuid would force a search before
 * every correction.
 *
 * Full uuids are resolved the same way rather than trusted. Reads deliberately
 * reach across repositories — `memory_search` and `memory_list` both take
 * `scope: "all"` — and that is where an agent working in one repository gets
 * hold of another repository's uuid. Passing uuids straight through would turn
 * that read access into write access over the whole store.
 */
async function resolveRecord(id, project) {
  const wanted = String(id ?? "").trim().toLowerCase();
  if (!wanted) throw new Error("A memory id is required.");
  if (!project?.id) throw new Error("A repository is required to change a memory.");
  const isMatch = (record) =>
    UUID.test(wanted) ? record.id.toLowerCase() === wanted : record.id.toLowerCase().startsWith(wanted);

  // Expired memories are included: clearing an expiry is exactly the case where
  // you need to name one, and it is invisible everywhere else.
  const reachable = await listMemories({ project, limit: STORE_SCAN_LIMIT, scope: "project", includeExpired: true });
  const matches = reachable.filter(isMatch);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `"${wanted}" matches ${matches.length} memories (${matches.map((m) => m.id.slice(0, 8)).join(", ")}); use more characters.`,
    );
  }

  // Nothing here — but "does not exist" and "belongs to someone else" call for
  // very different responses, so say which it is.
  const elsewhere = (
    await listMemories({ project, limit: STORE_SCAN_LIMIT, scope: "all", includeExpired: true })
  ).filter(isMatch);
  if (elsewhere.length > 0) {
    const owner = elsewhere[0].projectName ?? elsewhere[0].project;
    throw new Error(
      `Memory ${elsewhere[0].id.slice(0, 8)} belongs to another repository (${owner}); it can only be changed from there.`,
    );
  }
  throw new Error(`No memory in this repository has an id starting with "${wanted}".`);
}

export async function resolveMemoryId(id, project) {
  // No repository to scope against: internal maintenance callers (test
  // teardown) work off the full uuid they were just handed.
  if (!project?.id) {
    const wanted = String(id ?? "").trim().toLowerCase();
    if (UUID.test(wanted)) return wanted;
    throw new Error("Without a repository, a memory can only be named by its full uuid.");
  }
  return (await resolveRecord(id, project)).id;
}

/**
 * Correct a memory in place. mem0 keeps the id and the original createdAt and
 * only refreshes updatedAt, so the record's place in the store — and in the
 * next session's injection — survives the edit. That is the whole point: the
 * alternative, deleting and re-adding, loses both.
 *
 * Which repository a memory belongs to is not editable here, and cannot be:
 * mem0 runs `stripIdentityKeys` over the metadata an update supplies, so
 * `agent_id` is fixed at write time. Re-keying a repository is therefore a
 * maintenance job on the payloads themselves — `scripts/rekey-project.mjs`.
 */
export async function updateMemory({ id, text, kind, expiresAt, project }) {
  const hasText = text !== undefined && text !== null;
  const hasKind = kind !== undefined && kind !== null;
  // `null` is meaningful here — it is how mem0 clears an expiry — so only an
  // absent key counts as "leave it alone".
  const hasExpiry = expiresAt !== undefined;
  if (!hasText && !hasKind && !hasExpiry) {
    throw new Error("Nothing to update: provide text, kind or expiresAt.");
  }

  const record = await resolveRecord(id, project);
  const memoryId = record.id;
  const { memory, config } = await openMemory();
  if (hasKind) assertKind(kind, config);
  // Judged on the state this edit would leave behind, not on what it supplies:
  // the two ways to end up with an expiring kind and no expiry are promoting a
  // memory into one and clearing the expiry of one already there.
  assertExpiry(hasKind ? kind : record.kind, hasExpiry ? expiresAt : (record.expiresAt ?? null));

  // Only the keys being changed: mem0 merges this over the existing payload, so
  // anything left out (the repository, source, an expiry set earlier) is kept.
  const metadata = {};
  let trimmed;
  if (hasText) {
    trimmed = String(text).trim();
    if (!trimmed) throw new Error("Refusing to store an empty memory.");
    // The duplicate guard in addMemory matches on source_hash. Leaving the old
    // hash on an edited record would let the new text be stored again as a
    // second copy, and would keep blocking the text we just replaced.
    metadata.source_hash = crypto.createHash("md5").update(trimmed).digest("hex");
    const clash = (await findByInputHash(memory, scopeFilters(config, project, "project"), metadata.source_hash)).find(
      (other) => other.id !== memoryId,
    );
    if (clash) throw new Error(`Memory ${clash.id.slice(0, 8)} already says exactly this; delete one of the two instead.`);
  }
  if (hasKind) metadata.kind = kind;

  await detectDimension();
  await memory.update(memoryId, {
    ...(hasText ? { text: trimmed } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    // mem0 validates the YYYY-MM-DD shape and throws on anything else.
    ...(hasExpiry ? { expirationDate: expiresAt } : {}),
  });

  log(
    "memory",
    `update id=${memoryId} text=${hasText} kind=${hasKind ? kind : "-"} expires=${hasExpiry ? (expiresAt ?? "cleared") : "-"}`,
  );
  // Read back rather than echo the request: `get` is the only path that shows
  // an expired memory, so it is also the only honest confirmation of one.
  const updated = await memory.get(memoryId);
  return updated ? toRecord(updated) : { id: memoryId };
}

/**
 * What has happened to one memory, from mem0's own change log.
 *
 * mem0 appends a row on every ADD, UPDATE and DELETE — including the previous
 * text — and never reads it back on its own, so this is the only way to see what
 * a memory said before an edit. Which is the case it exists for: `updateMemory`
 * replaces the text in place, and without this the old wording is gone as far as
 * anyone can tell.
 *
 * The id is resolved against this repository exactly like an edit, even though
 * this only reads. History rows carry the memory id and nothing else — no
 * `agent_id` — so mem0 would happily return another repository's rows for a uuid
 * picked up from a `scope: "all"` search.
 */
export async function historyMemory({ id, project }) {
  const record = await resolveRecord(id, project);
  const { memory } = await openMemory();
  const rows = (await memory.history(record.id)) ?? [];
  return {
    record,
    // mem0 returns newest first (`ORDER BY id DESC`), which is also the only
    // reliable ordering here: the dates below do not say when the row was
    // written. `created_at` is the memory's own creation time, repeated on every
    // row; `updated_at` is set on UPDATE rows only; a DELETE row has neither.
    entries: rows.map((row) => ({
      action: row.action ?? null,
      previous: row.previous_value ?? null,
      next: row.new_value ?? null,
      createdAt: row.created_at ?? null,
      updatedAt: row.updated_at ?? null,
      deleted: row.is_deleted === 1,
    })),
  };
}

export async function deleteMemory(id, project) {
  const record = project?.id ? await resolveRecord(id, project) : null;
  const memoryId = record ? record.id : await resolveMemoryId(id, project);
  const { memory } = await openMemory();
  await memory.delete(memoryId);
  log("memory", `delete id=${memoryId}`);
  return { id: memoryId, deleted: true };
}

export async function statsMemories() {
  const { memory, config, embedder, llm } = await openMemory();
  // Read-only and deliberately unscoped: this is the one view across repositories.
  const filters = { user_id: config.userId };
  const raw = await memory.getAll({ filters, topK: STORE_SCAN_LIMIT });
  const records = (raw?.results ?? []).map(toRecord);
  // Expired memories are invisible everywhere else by design, which makes a
  // total that quietly omits them misleading — this is the one place that
  // should account for the whole file. Asking mem0 twice rather than comparing
  // dates ourselves keeps "expired" meaning exactly what mem0 means by it.
  const withExpired = await memory.getAll({ filters, topK: STORE_SCAN_LIMIT, showExpired: true });

  const byProject = {};
  const byKind = {};
  for (const record of records) {
    const projectKey = record.projectName ?? record.project ?? "unknown";
    byProject[projectKey] = (byProject[projectKey] ?? 0) + 1;
    const kindKey = record.kind ?? "unknown";
    byKind[kindKey] = (byKind[kindKey] ?? 0) + 1;
  }

  return {
    total: records.length,
    expired: Math.max(0, (withExpired?.results ?? []).length - records.length),
    byProject,
    byKind,
    userId: config.userId,
    dataDir: PATHS.home,
    embedder: embedder.info,
    llm: llm?.info ?? { provider: config.llm?.enabled ? (config.llm.provider ?? "openai") : "disabled" },
  };
}
