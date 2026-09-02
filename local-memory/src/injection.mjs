/**
 * What a fresh session should be told: the memories this repository has
 * accumulated, plus how to keep using the memory tools.
 *
 * Two channels deliver the same text, because neither one reaches every host.
 * Cursor's `sessionStart` hook is the native mechanism, but no ACP client runs
 * Cursor hooks — in a JetBrains IDE neither hook ever fires. The MCP server's
 * `instructions` field does reach the model there (the agent forwards it as the
 * server's usage instructions), and the server is started fresh for every
 * session, which makes it an equivalent moment to inject.
 */
import { listMemories } from "./memory.mjs";
import { ENGLISH_ONLY, KEEP_IDENTIFIERS, MEMORY_LENGTH, SPLIT_NOT_COMPRESS } from "./wording.mjs";

export const MEMORY_PROTOCOL = [
  "Memory protocol for this session:",
  // The list is the newest few memories plus the newest of each reserved kind,
  // which is still a fraction of the store: a repository's rules outnumber the
  // slots. Search is what makes the rest reachable, and an agent only searches
  // if it knows the list is partial.
  // Phrased so it stays true when nothing was injected at all, which is what
  // the empty-repository and budget-starved cases both produce.
  //
  // Naming the two searches rather than asking for a search is mem0's own
  // shape — its plugin's session-start hook says "Run 2 parallel searches: one
  // for decision type, one for task_learning type". The reason to copy it is
  // that an agent told only to search picks what to search for, and what it
  // picks is the topic in front of it, never the convention it is about to
  // break. In an ACP host this is also the only query-time retrieval there is:
  // no hook fires per turn, so nothing but the agent can run one.
  '- The list above is partial, so most of what this repository knows is reachable only by searching. Open every session with two `memory_search` calls before your first substantive answer — `kind: "convention"` for what this repository expects of you, `kind: "decision"` for why things are the way they are — and search again before following a convention you have not checked, and whenever the user refers to past work.',
  // mem0's own rules, restated because the default write path is verbatim and
  // never runs the prompt that states them. See `wording.mjs`.
  `- Call \`memory_add\` when you learn something durable: a user preference, a project convention, a decision and its reason, or a non-obvious pitfall. ${MEMORY_LENGTH} ${SPLIT_NOT_COMPRESS}`,
  // The subject is `memory_add`, not the store. mem0's "sole operation is ADD"
  // describes its extraction step, and generalising it to memories would be
  // false here — `memory_update` really does replace the text, which is the
  // whole reason this bullet points at it.
  "- Call `memory_update` when something above turns out to be wrong or out of date. `memory_add` only ever adds, never replaces, so a correction stored that way leaves both versions to come back in later searches.",
  "- `confidence` is evidence strength, not search relevance, and is derived from `evidence`. Set or change `evidence` only after real confirmation, verification, inference or unresolved contradiction — never after search, repetition or age. Verify injected memories marked `VERIFY` before acting. Confidence does not affect search ranking or deletion.",
  // Both retrieval signals mem0 fuses are English-bound, and the keyword one
  // fails outright rather than degrading: its lemmatiser matches /[a-z0-9]+/g,
  // so a CJK memory never reaches the keyword index at all — not as an
  // unsplittable token, as nothing. `KEEP_IDENTIFIERS` carries the consequence,
  // and `queryReachWarning` catches the query side at runtime when this bullet
  // is ignored, which is the only case it cannot prevent.
  `- Write memories and search queries in English, opening with the topic, even when the conversation is in another language. ${ENGLISH_ONLY} ${KEEP_IDENTIFIERS}`,
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
 * this cheap enough to run on every session in both channels.
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
      records.length === 0
        ? "No memories stored for this repository yet."
        : "This repository has memories, but none fit the injection budget — reach them with `memory_search`.",
      "",
    );
  }

  if (config.inject.includeProtocol) lines.push(MEMORY_PROTOCOL);

  // The count both callers log is what the session actually received, not how
  // many records were eligible.
  return { text: lines.join("\n"), count: body.length };
}
