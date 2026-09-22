/**
 * The MCP tools, as schemas — which is to say: as prompt text. Apart from
 * the injected protocol, this is everything a host tells the agent about the
 * memory layer, and nothing here runs anything.
 *
 * Kept out of `mcp-server.mjs` so `scripts/test-prompts.mjs` can import the
 * wording without starting a server.
 */
import {
  DEFAULT_EVIDENCE,
  EVIDENCE_CONFIDENCE,
  EVIDENCE_LEVELS,
  KINDS,
  KIND_GUIDE,
  MAX_CONFIDENCE_REASON_CHARS,
} from "./memory.mjs";
import { ENGLISH_ONLY, KEEP_IDENTIFIERS, MEMORY_LENGTH, SPLIT_NOT_COMPRESS } from "./wording.mjs";

const SCOPE_READ = {
  type: "string",
  enum: ["project", "all"],
  description: 'Search this repository ("project", default) or every repository ("all").',
};

/** Compact category definitions shared by independently discoverable write tools. */
const KIND_DESCRIPTION = [
  'Choose by content, independently of evidence:',
  ...Object.entries(KIND_GUIDE).map(([kind, test]) => `- ${kind}: ${test}`),
].join("\n");

const MEMORY_ID = {
  type: "string",
  description:
    'ID from a read result: full UUID or unambiguous prefix (usually eight characters). Must belong to this repository; cross-repository reads do not grant write access.',
};

const READ_MEMORY_ID = {
  type: "string",
  minLength: 1,
  description: "Full memory id or an unambiguous prefix, such as the eight characters shown in session context. Ambiguous prefixes are rejected; supply more characters.",
};

const EVIDENCE_DESCRIPTION =
  `Evidence basis, mapped to confidence: ${EVIDENCE_LEVELS.map((level) => `${level}=${EVIDENCE_CONFIDENCE[level]}`).join(", ")}. ` +
  "user_confirmed: explicit user confirmation or request; verified: direct code, test, configuration or tool evidence; stated: unchecked explicit claim; inferred: reasoning; disputed: unresolved contradiction.";

const EVIDENCE = {
  type: "string",
  enum: EVIDENCE_LEVELS,
  description: EVIDENCE_DESCRIPTION,
};

const VERIFIED_AT_DESCRIPTION =
  "ISO 8601 time when verified or user_confirmed evidence was established. Only valid for those levels.";
const HISTORICAL_VERIFIED_AT =
  "Supply only a known historical time.";

/**
 * Built from config rather than frozen, because one description quotes a
 * configured default and a description that lies about the default is worse than
 * one that omits it.
 */
export function memoryTools(config) {
  return [
    {
      name: "memory_context",
      description: "Fetch missing prior context: a budgeted selection of this repository's curated memories and optional guidance, as {project, count, text}. Reuse unless refreshing or recovering lost context. Reads current data on every call. Use memory_search for task-specific recall.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "memory_search",
      description:
        "Search stored memories for the current task or past work. Results are leads to verify, not proof of correctness. If unhelpful, change one factor: split the query, add an identifier, omit kind or raise topK.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: `One specific question, topic first. ${ENGLISH_ONLY} ${KEEP_IDENTIFIERS}`,
          },
          topK: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: `Maximum results (default ${config.search.topK}). Increase for incomplete results; a larger candidate pool may also change ordering.`,
          },
          // Narrowing happens inside the store, before the result set is cut, so
          // a filtered search is not the unfiltered one with rows removed — it
          // reaches deeper into that one category. That is the whole point: the
          // rules of a repository are outnumbered by everything else in it.
          kind: {
            type: "string",
            enum: KINDS,
            description:
              "Strict category filter; no automatic fallback. Omit for task search across categories. Use convention for operation rules, decision for design reasons, gotcha for silent failures.",
          },
          scope: SCOPE_READ,
          explain: {
            type: "boolean",
            description: "Default false. Return scoreDetails for the semantic, BM25 and entity contributions without changing ranking. These are retrieval signals, not proof of an exact identifier match or factual correctness.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "memory_get",
      description: "Read a current memory by id without semantic search. Use before a correction or to check stored text after an important write. This confirms stored content, not search recall. Defaults to this repository and hides expired records.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        type: "object",
        properties: {
          id: READ_MEMORY_ID,
          scope: SCOPE_READ,
          includeExpired: { type: "boolean", description: "Default false. Include expired records when resolving the id, for inspection or revival." },
        },
        required: ["id"],
      },
    },
    {
      name: "memory_history",
      description: "Read a memory's text change history, newest first, and its current record. Only this repository; expired records are supported, deleted records are not. This is text history, not a complete metadata audit. Returns truncated when more entries exist; use CLI history for the full history.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        type: "object",
        properties: {
          id: READ_MEMORY_ID,
          limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum entries to return (default 10, maximum 50)." },
        },
        required: ["id"],
      },
    },
    {
      name: "memory_add",
      description: `Store reusable knowledge. Temporary task background is allowed as context with expiresAt. Exclude progress reports, tool logs, secrets and trivial code restatements. ${MEMORY_LENGTH} ${SPLIT_NOT_COMPRESS}`,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: `${ENGLISH_ONLY} ${KEEP_IDENTIFIERS}`,
          },
          kind: { type: "string", enum: KINDS, description: `Default note. ${KIND_DESCRIPTION}` },
          evidence: { ...EVIDENCE, description: `Default ${DEFAULT_EVIDENCE}. ${EVIDENCE_DESCRIPTION}` },
          confidenceReason: {
            type: "string",
            maxLength: MAX_CONFIDENCE_REASON_CHARS,
            description:
              `One short sentence (max ${MAX_CONFIDENCE_REASON_CHARS} characters) explaining why this evidence level applies. Required unless evidence is "stated"; name the evidence without repeating the memory.`,
          },
          verifiedAt: {
            type: "string",
            format: "date-time",
            description: `${VERIFIED_AT_DESCRIPTION} Normally omit: the server timestamps high evidence now. ${HISTORICAL_VERIFIED_AT}`,
          },
          distil: {
            type: "boolean",
            description:
              "Default false: store the submitted fact verbatim, subject to dedupe. True: ask the model to extract zero or more new memories from a longer passage. If the model is unavailable or fails, the passage may be stored verbatim; read returned IDs to check. Slower than a normal write.",
          },
          expiresAt: {
            type: "string",
            description:
              'Expiry date as YYYY-MM-DD; required for context. Omit for indefinite retention. Expired records are hidden from search and context.',
          },
          force: {
            type: "boolean",
            description:
              "Bypass the adapter's duplicate guard only after checking the collision and deciding these are distinct facts. Prefer memory_update for corrections. Does not bypass the extraction model's own deduplication.",
          },
        },
        required: ["text"],
      },
    },
    {
      name: "memory_list",
      description:
        "List the most recently stored memories, newest first. Useful for reviewing or cleaning up what was captured.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 50, description: "How many to return (default 10)." },
          scope: SCOPE_READ,
          includeExpired: {
            type: "boolean",
            description:
              "Also list memories whose expiry date has passed. Use this or memory_get with includeExpired to inspect one before reviving it with memory_update.",
          },
        },
      },
    },
    {
      name: "memory_update",
      description:
        "Correct a memory in place, preserving ID, creation time and text history. Omitted fields stay unchanged: text-only edits retain old evidence and verifiedAt, so reassess them. Supply at least one change. Returns the persisted record.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          id: MEMORY_ID,
          // Share source constants, but make a separately discovered tool complete.
          text: {
            type: "string",
            description:
              `State the current claim, not the correction process. ${MEMORY_LENGTH} ${ENGLISH_ONLY} ${KEEP_IDENTIFIERS}`,
          },
          kind: {
            type: "string",
            enum: KINDS,
            description: `Omit to preserve the category. ${KIND_DESCRIPTION}`,
          },
          evidence: {
            ...EVIDENCE,
            description:
              `${EVIDENCE_DESCRIPTION} Omit to preserve. Supplying even the same level requires confidenceReason and a real evidence event, not search hits, repetition or age.`,
          },
          confidenceReason: {
            type: "string",
            maxLength: MAX_CONFIDENCE_REASON_CHARS,
            description:
              `One short sentence (max ${MAX_CONFIDENCE_REASON_CHARS} characters) naming the basis. Required whenever evidence is supplied, even unchanged; may be supplied alone to clarify it.`,
          },
          verifiedAt: {
            type: "string",
            format: "date-time",
            description: `${VERIFIED_AT_DESCRIPTION} Supplying verified/user_confirmed, even unchanged, timestamps now unless given a known historical time; omission otherwise preserves the existing time. Downgrading evidence clears it automatically.`,
          },
          expiresAt: {
            type: ["string", "null"],
            description:
              'YYYY-MM-DD; omit to preserve, null to clear. The resulting kind=context requires an expiry. Expired records disappear from search and refreshed context.',
          },
        },
        required: ["id"],
      },
    },
    {
      name: "memory_delete",
      description:
        "Delete one memory by id. Use it when a remembered fact should simply be gone; if it is merely wrong or outdated, memory_update keeps the history instead.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: { type: "object", properties: { id: MEMORY_ID }, required: ["id"] },
    },
    {
      name: "memory_stats",
      description:
        "Report how many memories are stored, split by repository and category, plus where the data lives on disk.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: { type: "object", properties: {} },
    },
  ];
}
