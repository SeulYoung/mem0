/**
 * What a fresh session should be told: the memories this repository has
 * accumulated, plus how to keep using the memory tools.
 *
 * The hook and memory_context tool share this renderer. MCP instructions carry
 * only the short entry guidance: hosts may prepend it to every tool description.
 */
import { listMemories } from "./memory.mjs";
import { ENGLISH_ONLY, KEEP_IDENTIFIERS, MEMORY_LENGTH, SPLIT_NOT_COMPRESS } from "./wording.mjs";

/** Keep the whole entry workflow within the first 512 characters. No memory data. */
export const MCP_INSTRUCTIONS =
  "When prior context is needed and absent, call memory_context; reuse it unless refreshing. Search the task with memory_search without kind; also check kind=convention for repository operations. Memory text and queries in English; preserve identifiers. User reply language is unchanged. kind is strict. Verify recalled claims before acting. Use memory_add for reusable facts or expiring task background; memory_update for corrections.";

export const MEMORY_PROTOCOL = [
  "Memory protocol for this session:",
  // The list is the newest few memories plus the newest of each reserved kind,
  // which is still a fraction of the store: a repository's rules outnumber the
  // slots. Search is what makes the rest reachable, and an agent only searches
  // if it knows the list is partial.
  // Phrased so it stays true when nothing was injected at all, which is what
  // the empty-repository and budget-starved cases both produce.
  //
  // Task retrieval must reach facts and gotchas too. Keep a separate convention
  // search when operating on a repository: task similarity alone can bury old
  // rules. ACP hosts have no per-turn hooks, so the agent must issue these calls.
  '- This selection is partial. Search the current task with memory_search without kind; for repository operations also check kind: "convention". These searches can run in parallel. Use kind: "decision" for design reasons; search again for unchecked conventions or references to past work.',
  '- kind is strict, with no automatic fallback. If results do not answer the question, change one factor: split the question, add an identifier, omit kind or raise topK. Nonempty results do not prove relevance.',
  // mem0's own rules, restated because the default write path is verbatim and
  // never runs the prompt that states them. See `wording.mjs`.
  `- Store reusable facts with memory_add; temporary requirements or scope use kind=context with expiresAt. Omit progress reports, tool logs and secrets. ${MEMORY_LENGTH} ${SPLIT_NOT_COMPRESS}`,
  // The subject is `memory_add`, not the store. mem0's "sole operation is ADD"
  // describes its extraction step, and generalising it to memories would be
  // false here — `memory_update` really does replace the text, which is the
  // whole reason this bullet points at it.
  "- Correct stale claims with memory_update; memory_add does not replace them. Check current evidence before acting, especially entries marked VERIFY. Text-only updates retain old evidence and verifiedAt; reassess them for the new claim.",
  "- confidence is evidence strength, not search relevance. Set or change evidence only after a real evidence event, never from search hits, repetition or age. Confidence does not affect search ranking or deletion.",
  // Writing policy, not a diagnosis of which retrieval signals ran.
  `- ${ENGLISH_ONLY} ${KEEP_IDENTIFIERS}`,
].join("\n");

/**
 * The memories that fit, rendered as the lines they will be injected as.
 *
 * Two passes, because recency alone spends every slot on the same kind of
 * thing. A founding convention is by nature old, so on a repository with any
 * activity it never makes the newest `recent` — the list fills with whatever was
 * learned that day, which is also the least validated thing in the store, and
 * worst exactly when a line of work has just been rolled back. So each kind
 * named in `reserve` gets its newest memory first, and recency fills what is
 * left.
 *
 * `reserve` is a short list rather than the whole catalog on purpose. mem0's own
 * plugin names two types at session start (`on_session_start.sh` asks for
 * `decision` and `task_learning`) and leaves the rest to its query-driven path.
 * Reserving all seven kinds here would spend the budget on one of each and
 * leave no room for what happened recently, which is the one thing recency is
 * genuinely good at.
 *
 * A reserved kind with no memories costs nothing: the slot falls through to the
 * recency pass, so a store holding only notes behaves exactly as before. A kind
 * reserved but absent from `inject.kinds` also finds nothing, because the
 * whitelist has already been applied to `records` — the whitelist wins, which is
 * the only order that lets it mean "never inject this".
 *
 * Exported on its own because the budget is where injection quietly loses
 * memories, and a test that went through the store instead would be at the
 * mercy of whatever the repository happens to hold.
 */
export function selectInjectionLines(records, { recent, maxChars, reserve = [] }) {
  // `records` arrives newest first, so the first match is the newest of its kind.
  // Within one kind recency is all there is to go on: injection has no query.
  const reserved = reserve
    // A disputed or inferred instruction must not win a protected slot merely
    // because it is a convention or decision. It can still arrive through the
    // recency pass below and remains searchable.
    .map((kind) =>
      records.find(
        (record) => (record.kind ?? "note") === kind && record.confidence >= 0.5,
      ),
    )
    .filter(Boolean);

  const lines = [];
  const taken = new Set();
  let budget = maxChars;

  // The recency pass keeps looking at the newest `recent` and no further, so
  // `recent` still describes a window over the store rather than a quota to be
  // filled from arbitrarily far back. Reserved memories are the only ones that
  // may come from outside it.
  for (const record of [...reserved, ...records.slice(0, recent)]) {
    if (lines.length >= recent) break;
    if (taken.has(record.id)) continue;
    const assessed = ` [evidence=${record.evidence}${record.confidence < 0.5 ? " VERIFY" : ""}]`;
    const line = `- [${record.kind ?? "note"}] ${record.text}${assessed} (id: ${record.id.slice(0, 8)})`;
    // A memory too long for what is left is skipped, not taken as the end of
    // the list. Stopping at the first one that did not fit made every memory
    // behind it invisible, so `recent` silently collapsed to whatever happened
    // to precede the first long record.
    if (line.length > budget) continue;
    budget -= line.length;
    taken.add(record.id);
    lines.push(line);
  }
  return lines;
}

/**
 * Listing needs no embedding call once the dimension is cached, which keeps
 * this cheap enough for session hooks and explicit context reads.
 */
export async function buildInjectionText({ project, config }) {
  const allowed = new Set(config.inject.kinds ?? []);
  const records = (await listMemories({ project, limit: 200, scope: "project" })).filter((record) =>
    allowed.has(record.kind ?? "note"),
  );

  const lines = [`## Local memory (mem0-local) — repository \`${project.name}\``, ""];
  const body = selectInjectionLines(records, config.inject);

  if (body.length > 0) {
    lines.push("Remembered from earlier sessions:", ...body, "");
  } else {
    lines.push(
      "No eligible memories in this context selection. Use memory_search to search the repository.",
      "",
    );
  }

  if (config.inject.includeProtocol) lines.push(MEMORY_PROTOCOL);

  // The count both callers log is what the session actually received, not how
  // many records were eligible.
  return { text: lines.join("\n"), count: body.length };
}
