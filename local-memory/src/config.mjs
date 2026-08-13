import fs from "node:fs";
import os from "node:os";

import { PATHS, ensureDirs } from "./paths.mjs";

/**
 * mem0 validates user/agent/run ids and rejects anything empty or containing
 * whitespace. The default owner here is the OS account name, which on Windows
 * routinely has a space in it, so fold whitespace into hyphens rather than let
 * every single write fail.
 */
export function normalizeUserId(value) {
  return String(value ?? "").trim().replace(/\s+/g, "-") || "local-user";
}

export const DEFAULT_CONFIG = {
  /** Owner of the memories. Every record is scoped to this id. */
  userId: normalizeUserId(os.userInfo().username),

  embedder: {
    /** "fastembed" = fully local ONNX model. "openai" = any OpenAI-compatible /embeddings endpoint. */
    provider: "fastembed",
    /**
     * fastembed choices (size / dims). Measured on this project's own memories
     * with `scripts/bench-embedding.mjs` (top-1 hit rate on 12 natural questions):
     *   fast-bge-small-en-v1.5   ~50MB  384  — English memories: 92%. The default.
     *   fast-bge-small-zh-v1.5   ~50MB  512  — Chinese memories: 75%
     *   fast-multilingual-e5-large ~2GB 1024 — Chinese: also 75%, and a much
     *                                          narrower score margin. Not worth it.
     * English wins because the memory text is written by the summarisation model,
     * not by you — see `llm.customInstructions`. Changing this model invalidates
     * the vectors: delete ~/.mem0-local/vectors*.db and re-add the memories.
     */
    model: "fast-bge-small-en-v1.5",
    /** Only used when provider is "openai". */
    baseURL: null,
    apiKey: null,
    /** Filled in automatically on first use so later runs skip loading the model. */
    dimension: null,
    /** Which model the cached `dimension` belongs to; a mismatch discards it. */
    dimensionModel: null,
  },

  /**
   * Lets mem0 distill raw text into facts instead of storing it verbatim. Every
   * pathway falls back to verbatim storage when the model is unreachable, so a
   * broken LLM never costs you a memory.
   */
  llm: {
    enabled: true,
    /**
     * "cursor-cli" drives the Cursor CLI in print mode — the only synchronous
     * prompt-to-text path Cursor documents (there is no OpenAI-compatible
     * endpoint). "openai" targets any OpenAI-compatible /chat/completions URL.
     */
    provider: "cursor-cli",
    /**
     * Must be a slug from `cursor-agent models`. Plain "claude-sonnet-5" is not
     * one; the effort variants are. Extraction is an easy task, so "low" keeps
     * it cheap and fast — "-medium" / "-high" also work.
     */
    model: "claude-sonnet-5-low",
    /** Leave null to auto-detect the CLI on PATH; set an absolute path to pin it. */
    command: null,
    /**
     * null   → reuse whoever `cursor-agent status` is logged in as
     * "env:CURSOR_API_KEY" → read the token from that environment variable
     * "crsr_…" → the literal token (stored in plain text in this file)
     */
    apiKey: null,
    timeoutMs: 120000,
    /** Each call bills tokens to your Cursor account; this caps a runaway loop. */
    maxCallsPerDay: 200,
    /**
     * Appended to mem0's extraction prompt. English is deliberate: it is what the
     * embedding model is strongest at (92% vs 75% top-1, see `embedder.model`),
     * and it costs nothing extra because this call happens either way. Identifiers
     * must survive verbatim — they are what the BM25 and entity signals match on.
     */
    customInstructions:
      "Write every memory in English, translating from the source language when needed. Open each memory with the topic it is about, so a question about that topic matches it. Keep identifiers, file names, paths, command names and quoted strings exactly as they appear in the source — never translate or reformat them.",
    /** Only used when provider is "openai". */
    baseURL: null,
  },

  /**
   * mem0's own reranker, re-scoring the hits it already found with a
   * cross-encoder that reads query and memory together instead of comparing two
   * independent vectors. It fixes the failure the fused score cannot: that score
   * spreads real and irrelevant hits across a narrow band (measured here: 0.23
   * to 0.68), so a memory that answers the question exactly can sit third
   * behind two that merely share vocabulary. The cross-encoder separates them by
   * orders of magnitude instead.
   *
   * Costs a one-off ~87MB model download into `models/transformers`, then about
   * 600ms per search. Turn it off if that is not worth it to you.
   */
  reranker: {
    enabled: true,
    /**
     * "sentence_transformer" is Xenova/ms-marco-MiniLM-L-6-v2 (~87MB), the
     * smaller of mem0's two local options; "huggingface" is Xenova/bge-reranker-base
     * (~4x bigger, multilingual). mem0 also offers "cohere" and "zero_entropy",
     * which are HTTP APIs — using them would send your memory text off the machine.
     */
    provider: "sentence_transformer",
    /** null keeps the provider's default model. */
    model: null,
    /**
     * How many hits to hand the cross-encoder before cutting down to the caller's
     * topK. Reranking only re-orders what the first stage found, so this is the
     * window it gets to work in: too narrow and the right memory was already cut.
     */
    candidates: 25,
  },

  /** Retrieval knobs that belong to mem0's search, not to ours. */
  search: {
    /**
     * mem0's relevance floor on the fused score. null leaves mem0's own default
     * (0.1) in place. Raising it is tempting but the fused score is not
     * comparable across queries — mem0 normalises by a divisor that depends on
     * which signals fired anywhere in the candidate set — so a floor that looks
     * right for one query silently empties another.
     */
    threshold: null,
  },

  /**
   * Refusing to store the same thing twice. mem0 only compares memories on its
   * extraction path, so on every other path this is the only thing standing
   * between you and three copies of one fact.
   */
  dedupe: {
    /**
     * Cosine similarity above which a new memory counts as a restatement of an
     * existing one. Measured against this project's own memories: an identical
     * text scores 1.00, a genuine reword of one memory 0.93, and the nearest
     * "same topic, different fact" case 0.85. 0.92 sits in that gap, deliberately
     * nearer the top: missing a near-duplicate only leaves you with two similar
     * memories, while a false match would silently drop a new fact.
     */
    similarity: 0.92,
  },

  /** Deterministic capture of user prompts by the beforeSubmitPrompt hook. */
  capture: {
    enabled: true,
    minChars: 25,
    maxChars: 4000,
    /** Prompts starting with any of these are ignored (slash commands, etc.). */
    skipPrefixes: ["/"],
    /** Category used for captured prompts; kept out of `inject.kinds` on purpose. */
    kind: "prompt",
    /**
     * Distil captured prompts through the LLM. This runs in a detached
     * background process, so the extra seconds cost you nothing interactively.
     */
    infer: true,
    /**
     * Every captured prompt goes through the model, however short. Verbatim
     * storage would leave the original language in the store, and the embedding
     * model is English-only — an unprocessed Chinese prompt is close to
     * unretrievable. Raise this to trade recall for fewer calls.
     */
    inferMinChars: 25,
  },

  /** What a fresh session is told about this repository before you type. */
  inject: {
    enabled: true,
    /** Channel 1: Cursor's sessionStart hook. Silently absent in hosts that ignore hooks. */
    hookContext: true,
    /**
     * Channel 2: the MCP server's `instructions`. The only channel that reaches
     * ACP hosts (JetBrains IDEs and the like), where no Cursor hook ever fires.
     * Both channels are on by default, which costs a duplicate memory list in
     * Cursor itself; turn one off once you know which host you use.
     */
    mcpInstructions: true,
    recent: 8,
    /**
     * Has to be able to hold `recent` records, or the smaller of the two limits
     * wins and the other one is a lie. Measured on this repository's own
     * memories: an injected line runs 400-800 characters (a self-contained
     * sentence plus the `[kind]` and id it is rendered with), averaging around
     * 530, so eight of them need this much with a little headroom.
     */
    maxChars: 5000,
    /**
     * Only curated memories are injected. Raw captured prompts stay searchable
     * through memory_search but would otherwise crowd out the useful records.
     */
    kinds: ["preference", "convention", "decision", "gotcha", "fact", "note"],
    /** Also tell the agent how to use the memory tools every session. */
    includeProtocol: true,
  },

  /**
   * Deleting what has expired. Expiry itself only hides a memory from `search`
   * and `getAll`; the row stays, and an expired row is not inert — mem0's
   * keyword pass does not filter them and its entity filter is scoped by user
   * only, so an expired memory can still raise the divisor that visible results
   * are normalised by. Install the monthly sweep with `npm run install-sweeper`.
   */
  prune: {
    /**
     * Days between a memory's expiry date and the sweep deleting it. Expiry is
     * documented as reversible (`list --expired`, `update --clear-expiry`), and
     * deleting on the expiry date itself would quietly withdraw that promise, so
     * the sweep only takes what has been expired for a whole grace window.
     * Read at sweep time, so changing it needs no re-registration of the task.
     */
    expiredGraceDays: 30,
    /** Only read when installing the task: which day of the month it runs. */
    dayOfMonth: 1,
  },

  /**
   * Scheduled check that the memory layer would still start if you opened a
   * session now. It exists because every way this breaks is silent: a model
   * with no memory tools answers exactly like a model whose search found
   * nothing. Install it with `npm run install-watchdog`.
   */
  watchdog: {
    enabled: true,
    /**
     * How often the scheduled task runs. Only read when installing the task.
     * Two hours is plenty: the failures this catches (an upgrade, a rewired
     * config) happen at most a few times a year, and the task also runs shortly
     * after every logon, which is when they actually land.
     */
    everyMinutes: 120,
    /** Re-notify about a problem that is still unfixed at most this often. */
    repeatHours: 12,
    /** Generous: the first probe of the day may pay for loading the ONNX model. */
    probeTimeoutMs: 90000,
    /** Off leaves the verdict in watchdog.json and the log, with no popup. */
    notify: true,
  },

  /** mem0 sends anonymous telemetry by default; off here. */
  telemetry: false,
};

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Defaults that were wrong and have been corrected since installs already wrote
 * them to disk.
 *
 * `ensureConfigFile` snapshots the whole default set into config.json on first
 * run, so a field that is already there never picks up a new default again — a
 * corrected value would reach new machines only. A stored value is dropped only
 * when it still equals the superseded default, which leaves any figure you
 * chose yourself alone.
 */
const SUPERSEDED_DEFAULTS = [
  /**
   * 2500 could not hold `inject.recent` memories once they were written as
   * self-contained sentences, so injection stopped at four and the configured
   * eight never happened.
   */
  { path: ["inject", "maxChars"], was: 2500 },
];

/** Returns true when something was dropped, so the caller can rewrite the file. */
function dropSupersededDefaults(onDisk) {
  let dropped = false;
  for (const { path, was } of SUPERSEDED_DEFAULTS) {
    const parent = path.slice(0, -1).reduce((node, key) => (isPlainObject(node) ? node[key] : undefined), onDisk);
    const leaf = path[path.length - 1];
    if (isPlainObject(parent) && parent[leaf] === was) {
      delete parent[leaf];
      dropped = true;
    }
  }
  return dropped;
}

function deepMerge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    out[key] = isPlainObject(value) && isPlainObject(base?.[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

export function loadConfig() {
  let onDisk = {};
  try {
    onDisk = JSON.parse(fs.readFileSync(PATHS.configFile, "utf8"));
  } catch {
    // missing or unreadable config — fall back to defaults
  }
  dropSupersededDefaults(onDisk);
  const config = deepMerge(DEFAULT_CONFIG, onDisk);

  // A dimension cached for a different model is worse than no cache: mem0 would
  // build its store around the wrong width. Forget it and re-probe.
  if (config.embedder.dimension && config.embedder.dimensionModel !== config.embedder.model) {
    config.embedder.dimension = null;
  }

  if (process.env.MEM0_LOCAL_USER_ID) config.userId = process.env.MEM0_LOCAL_USER_ID;
  config.userId = normalizeUserId(config.userId);
  // Escape hatch for tests and for working offline: keeps everything running,
  // just stores memories verbatim instead of calling the model.
  if (process.env.MEM0_LOCAL_NO_LLM === "1") config.llm.enabled = false;
  // Same escape hatch for the cross-encoder: lets a machine that has never
  // downloaded the model run everything, at mem0's fused ranking.
  if (process.env.MEM0_LOCAL_NO_RERANK === "1") config.reranker.enabled = false;
  if (!config.telemetry) process.env.MEM0_TELEMETRY = "false";

  return config;
}

export function saveConfig(config) {
  ensureDirs();
  // Overlapping sessions write this file (every MCP server, every hook), so it
  // is replaced whole rather than truncated and refilled in place: a reader
  // arriving mid-write sees either version, never a half-written one.
  const temp = `${PATHS.configFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(temp, PATHS.configFile);
}

/**
 * Write the default config file on first run so there is something to edit, and
 * bring a file written by an older version up to date. Both injection channels
 * call this at session start, which makes it the reliable moment to migrate.
 */
export function ensureConfigFile() {
  if (!fs.existsSync(PATHS.configFile)) {
    saveConfig(DEFAULT_CONFIG);
    return loadConfig();
  }

  // Rewritten so the file agrees with the behaviour: leaving the superseded
  // value on disk would mean config.json says 2500 while injection uses 5000.
  // Once rewritten the value no longer matches, so this happens exactly once.
  try {
    const onDisk = JSON.parse(fs.readFileSync(PATHS.configFile, "utf8"));
    // Merged from the file rather than from `loadConfig`, whose result has the
    // environment overrides folded in — persisting those would turn one run
    // with MEM0_LOCAL_NO_RERANK=1 into a permanent setting.
    if (dropSupersededDefaults(onDisk)) saveConfig(deepMerge(DEFAULT_CONFIG, onDisk));
  } catch {
    // an unreadable or unwritable config must not stop a session starting
  }
  return loadConfig();
}

/** Persist the embedding dimension so list-only operations never load the model. */
export function rememberDimension(dimension) {
  if (!Number.isInteger(dimension) || dimension <= 0) return;
  const current = loadConfig();
  if (current.embedder.dimension === dimension && current.embedder.dimensionModel === current.embedder.model) return;
  current.embedder.dimension = dimension;
  current.embedder.dimensionModel = current.embedder.model;
  saveConfig(current);
}
