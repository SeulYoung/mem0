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

export const MEMORY_PROTOCOL = [
  "Memory protocol for this session:",
  // The list is the newest few memories and nothing else — a founding decision
  // is by nature old, so the one memory most worth having is the one most
  // likely to be missing. Search is what makes it reachable, and an agent only
  // searches if it knows the list is partial.
  // Phrased so it stays true when nothing was injected at all, which is what
  // the empty-repository and budget-starved cases both produce.
  "- Injection carries at most a handful of the newest memories, so anything older is reachable only by searching. Call `memory_search` before answering anything that may depend on earlier sessions, before following a project convention you have not checked, and whenever the user refers to past work.",
  // Length and self-containment are mem0's own contract for a memory (its
  // extraction prompt asks for a self-contained statement of 15-80 words), and
  // the default write path here is verbatim, which never runs that prompt. So
  // the requirement has to be restated where the agent can see it.
  "- Call `memory_add` when you learn something durable: a user preference, a project convention, a decision and its reason, or a non-obvious pitfall. One self-contained statement each, 15-80 words, stating the fact itself rather than the conversation it came from.",
  "- Call `memory_update` when something above turns out to be wrong or out of date. Memories are only ever added, never overwritten, so a correction stored as a new memory leaves both versions to come back in later searches.",
  // Both retrieval signals mem0 fuses are English-bound, and the keyword one
  // fails outright rather than degrading: its lemmatiser matches /[a-z0-9]+/g,
  // so a CJK memory becomes a single token that no query can hit.
  "- Write memories and search queries in English, opening with the topic, even when the conversation is in another language. Retrieval is English-only: the embedding model is English, and the keyword index cannot split CJK text into words at all. Keep identifiers, file names and command names exactly as they appear.",
].join("\n");

/**
 * The memories that fit, rendered as the lines they will be injected as.
 *
 * Exported on its own because the budget is where injection quietly loses
 * memories, and a test that went through the store instead would be at the
 * mercy of whatever the repository happens to hold.
 */
export function selectInjectionLines(records, { recent, maxChars }) {
  const lines = [];
  let budget = maxChars;
  for (const record of records.slice(0, recent)) {
    const line = `- [${record.kind ?? "note"}] ${record.text} (id: ${record.id.slice(0, 8)})`;
    // A memory too long for what is left is skipped, not taken as the end of
    // the list. Stopping at the first one that did not fit made every memory
    // behind it invisible, so `recent` silently collapsed to whatever happened
    // to precede the first long record.
    if (line.length > budget) continue;
    budget -= line.length;
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
