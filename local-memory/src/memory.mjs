import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { loadConfig, rememberDimension } from "./config.mjs";
import { createEmbedder } from "./embedder.mjs";
import { createLlm, resolveApiKey } from "./llm.mjs";
import { PATHS, ensureDirs, log } from "./paths.mjs";
import { GLOBAL_SCOPE } from "./project.mjs";
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
 * One history database per repository. mem0 keeps two things in there: the
 * change log, and the recent messages it replays into the extraction prompt as
 * `## Last k Messages`. That replay is scoped by user/agent/run only — never by
 * our project metadata — so a shared file would let one repository's prompts
 * steer what gets extracted in another. Separate files scope it by construction.
 */
export function historyDbFor(project) {
  if (!project?.id) return PATHS.historyDb;
  const slug =
    project.id
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "project";
  const digest = crypto.createHash("md5").update(project.id).digest("hex").slice(0, 8);
  return path.join(PATHS.historyDir, `${slug}-${digest}.db`);
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
const instances = new Map();

/** Everything that does not depend on which repository we are working in. */
async function openBase() {
  if (base) return base;
  ensureDirs();
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
 * A mem0 instance for one repository. Callers that write always pass a project;
 * read-only callers (stats, doctor) may omit it and share one instance.
 */
export async function openMemory(project) {
  const shared = await openBase();
  const key = project?.id ?? "__shared__";
  if (!instances.has(key)) {
    const { Memory } = await import("mem0ai/oss");
    const historyDbPath = historyDbFor(project);
    // Before constructing, while nothing else holds the file: switching journal
    // mode needs exclusive access.
    await setWal(historyDbPath);
    instances.set(key, new Memory(memoryConfig({ ...shared, historyDbPath })));
  }
  return { ...shared, memory: instances.get(key) };
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
    project: metadata.project ?? null,
    projectName: metadata.project_name ?? null,
    kind: metadata.kind ?? null,
    source: metadata.source ?? null,
    sourceHash: metadata.source_hash ?? null,
    // mem0 stamps createdAt itself; we never write a timestamp of our own.
    createdAt: item.createdAt ?? null,
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
 * Scope a query to this repository plus anything marked global. The filter is
 * handed to mem0 so it applies inside the store, before top-k truncation —
 * filtering afterwards would let other repositories crowd out the real hits.
 * Also used on writes, where mem0 searches existing memories to decide what is
 * new. `{ project: [...] }` is mem0's own "in" shorthand.
 */
export function scopeFilters(config, project, scope) {
  const filters = { user_id: config.userId };
  if (scope !== "all") filters.project = [project.id, GLOBAL_SCOPE];
  return filters;
}

/** Second line of defence in case a future mem0 changes filter semantics. */
function visibleIn(record, projectId, scope) {
  if (scope === "all") return true;
  return record.project === projectId || record.project === GLOBAL_SCOPE;
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
  note: "None of the above, and still worth having next session. The fallback, and rarely the right answer.",
};

export const KINDS = Object.keys(KIND_GUIDE);

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
 * applies filters inside the store, and arbitrary metadata keys work there —
 * `project` in `scopeFilters` is one of ours already — so this is a keyed lookup
 * and not a scan of the whole collection.
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
 * The nearest existing memory, if it is close enough to count as a restatement.
 *
 * mem0 does this itself on its extraction path, where the model is shown the
 * neighbouring memories and told to only report what is new. The verbatim path
 * has no such step, so this asks the same question the only way it can be asked
 * without a model: embed the text and look at what it lands on top of.
 */
async function findNearDuplicate(memory, filters, text, similarity) {
  const raw = await memory.search(text, { filters, topK: 1, explain: true });
  const [top] = raw?.results ?? [];
  // `semanticScore` is the plain cosine between the two embeddings. The fused
  // `score` beside it cannot be used for this: mem0 divides it by a factor that
  // depends on which signals fired anywhere in the candidate set, so it moves
  // for reasons that have nothing to do with this pair of texts.
  const cosine = top?.score_details?.semanticScore;
  if (typeof cosine !== "number" || cosine < similarity) return null;
  return { record: toRecord(top), similarity: cosine };
}

export async function addMemory({
  text,
  project,
  kind = "note",
  source = "mcp",
  global = false,
  infer = false,
  expiresAt = null,
  dedupeKey = null,
  dedupe = true,
}) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) throw new Error("Refusing to store an empty memory.");

  const { memory, config } = await openMemory(project);
  assertKind(kind, config);
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
    // Scope what mem0 compares against. Its extraction path searches existing
    // memories and hands the top hits to the model to decide what is genuinely
    // new; unscoped, a memory from another repository could make it drop a fact
    // this repository does not have. Same filter shape as search/getAll, applied
    // by mem0 inside the store.
    filters,
    metadata: {
      project: global ? GLOBAL_SCOPE : project.id,
      project_name: global ? GLOBAL_SCOPE : project.name,
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
  try {
    result = await memory.add(trimmed, { ...options, infer: wantInfer });
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
      project: options.metadata.project,
      projectName: options.metadata.project_name,
      kind: options.metadata.kind,
      source: options.metadata.source,
      sourceHash: options.metadata.source_hash ?? null,
    })) {
      record[key] ??= value;
    }
    return record;
  });
  log(
    "memory",
    `add project=${global ? GLOBAL_SCOPE : project.id} kind=${kind} source=${source} infer=${inferred} stored=${stored.length}`,
  );
  return stored;
}

export async function searchMemories({
  query,
  project,
  topK = 6,
  scope = "project",
  explain = false,
  rerank = null,
  threshold = null,
}) {
  const { memory, config } = await openMemory(project);
  await detectDimension();

  // The reranker only re-orders what the first stage already found, so ask mem0
  // for a wider set than the caller wants and let the cross-encoder choose from
  // it. Asking for exactly topK would rerank the one list we were going to
  // return anyway, which is where reranking has the least to offer.
  const wantRerank = rerank ?? Boolean(rerankerConfig(config));
  const reranking = wantRerank && (await rerankerReady());
  const candidates = reranking ? Math.max(topK, config.reranker?.candidates ?? 25) : topK;
  const floor = threshold ?? config.search?.threshold;

  const raw = await memory.search(String(query ?? "").trim(), {
    filters: scopeFilters(config, project, scope),
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
    .slice(0, topK);
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
  const { memory, config } = await openMemory(project);

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
 * Which repository's mem0 instance should perform a write. mem0 logs a change
 * against whichever instance made it and we keep one history database per
 * repository, so editing a global memory from here would file its history under
 * this repository — and the same memory's history would end up scattered across
 * every repository that ever touched it. Route by owner instead.
 */
function ownerOf(record, project) {
  if (!record?.project || record.project === project?.id) return project;
  return { id: record.project, name: record.projectName ?? record.project };
}

/**
 * Correct a memory in place. mem0 keeps the id and the original createdAt and
 * only refreshes updatedAt, so the record's place in the store — and in the
 * next session's injection — survives the edit. That is the whole point: the
 * alternative, deleting and re-adding, loses both.
 */
export async function updateMemory({ id, text, kind, expiresAt, scope, project }) {
  const hasText = text !== undefined && text !== null;
  const hasKind = kind !== undefined && kind !== null;
  const hasScope = scope !== undefined && scope !== null;
  // `null` is meaningful here — it is how mem0 clears an expiry — so only an
  // absent key counts as "leave it alone".
  const hasExpiry = expiresAt !== undefined;
  if (!hasText && !hasKind && !hasExpiry && !hasScope) {
    throw new Error("Nothing to update: provide text, kind, expiresAt or scope.");
  }
  if (hasScope && scope !== "project" && scope !== "global") {
    throw new Error(`Unknown scope "${scope}". Use "project" or "global".`);
  }

  const record = await resolveRecord(id, project);
  const memoryId = record.id;
  const { memory, config } = await openMemory(ownerOf(record, project));
  if (hasKind) assertKind(kind, config);

  // Only the keys being changed: mem0 merges this over the existing payload, so
  // anything left out (project, source, an expiry set earlier) is preserved.
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
  if (hasScope) {
    // Moving scope in place is the only way to promote a repository memory to
    // global without losing its id and its original date.
    metadata.project = scope === "global" ? GLOBAL_SCOPE : project.id;
    metadata.project_name = scope === "global" ? GLOBAL_SCOPE : project.name;
  }

  await detectDimension();
  await memory.update(memoryId, {
    ...(hasText ? { text: trimmed } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    // mem0 validates the YYYY-MM-DD shape and throws on anything else.
    ...(hasExpiry ? { expirationDate: expiresAt } : {}),
  });

  log(
    "memory",
    `update id=${memoryId} text=${hasText} kind=${hasKind ? kind : "-"} scope=${hasScope ? scope : "-"} expires=${hasExpiry ? (expiresAt ?? "cleared") : "-"}`,
  );
  // Read back rather than echo the request: `get` is the only path that shows
  // an expired memory, so it is also the only honest confirmation of one.
  const updated = await memory.get(memoryId);
  return updated ? toRecord(updated) : { id: memoryId };
}

export async function deleteMemory(id, project) {
  const record = project?.id ? await resolveRecord(id, project) : null;
  const memoryId = record ? record.id : await resolveMemoryId(id, project);
  const { memory } = await openMemory(ownerOf(record, project));
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
