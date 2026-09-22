/**
 * The claims more than one agent-facing text has to make the same way.
 *
 * The default write path is verbatim, so mem0's contract for what a memory
 * should look like reaches the agent writing one only if the injected protocol
 * and the tool schemas restate it — hence one copy here, composed at each site,
 * with whatever is genuinely local staying local.
 *
 * Nothing here belongs in `llm.customInstructions`: that text is appended to the
 * contract itself, where restating it would only argue with mem0 in its own
 * voice.
 *
 * Most claims are mem0's, from `ADDITIVE_EXTRACTION_PROMPT`'s "Memory Quality
 * Standards". mem0 exports no prompts, so `scripts/test-prompts.mjs` reads the
 * installed bundle instead and fails when one of them is no longer in it. The
 * two that are *not* mem0's are marked as such, and the same test asserts they
 * are still stated, because a divergence nobody can see is a bug.
 */

/**
 * mem0's "Concise but Complete" standard — the 15-80 band, the allowance for
 * detail-rich content, the three-sentence case, and the rule that completeness
 * outranks the count — with one deliberate change: what gets counted.
 *
 * mem0's band assumes prose. In a code repository it is spent on the wrong
 * things: `Source/.../CapturableStageRewardComponent.h` is one word by any
 * split and carries more than the sentence around it, while four bare symbol
 * names cost four words and are the entire reason the memory exists. Counting
 * only the prose, and naming what may never be cut, tells a writer what to
 * delete — the narration — in a way a word range cannot. The hard cap replaces
 * mem0's 100 rather than adding to it, because a band with an allowance above
 * it and a priority rule above that has no ceiling anyone can act on.
 */
export const MEMORY_LENGTH =
  "State one self-contained fact, topic first, without conversation history. Aim for 15-80 prose words in 1-3 sentences; maximum 120. Exclude identifiers, paths, code and figures from the count. Keep relevant details, symptoms and remedies; cut narration. Completeness beats brevity.";

/**
 * mem0's escape for a topic that does not fit — "split into multiple focused
 * memories rather than compressing details away" — spelled out as a second call,
 * for the default verbatim path; distil can produce zero or multiple memories.
 */
export const SPLIT_NOT_COMPRESS =
  "Split independent facts instead of compressing away details. By default, submit each in a separate memory_add call; duplicates may store nothing.";

/**
 * Not mem0's: mem0's own prompt imposes no language rule at all, so this layer
 * adds one. Why, and why it goes unopposed rather than overriding something, is
 * in `llm.customInstructions`.
 *
 * This is a policy for stored text and queries, not for user-facing replies.
 * Do not claim CJK is always absent: pure CJK has a lemmatisation fallback,
 * and quoted CJK can enter the entity path. Neither guarantees useful recall.
 */
export const ENGLISH_ONLY =
  "Write memory text and search queries in English for retrieval; this does not set the language of replies to the user.";

/**
 * mem0's "Preserve Specific Details", narrowed to what a code repository's
 * memories turn on: identifiers are what the keyword and entity signals match on.
 *
 * Keep code spelling even when English is required for prose. English glosses
 * helped retrieval in the experiments below; this is not a guarantee that an
 * untranslated identifier is unreachable through every signal.
 *
 * `bench-retrieval.mjs` measures the rule end to end rather than identifier by
 * identifier, and it holds: English questions that never name the CJK
 * identifier find the memory 3/3, because the English gloss alone lights up
 * both keyword and entity. Re-checked against 45 real memories in another
 * repository, 7 of which carry CJK identifiers an agent wrote under this rule:
 * 4/5 and 3/3 on the same two shapes of question. That script asserts both
 * halves of this and exits non-zero if either stops being true.
 *
 * Two CJK-only queries in that corpus returned the same unrelated memory with
 * the most CJK characters. That observation motivates a warning, not a claim
 * that all CJK queries are ranked by character counts.
 *
 * Do not "fix" the unreachable entity route by telling agents to quote a CJK
 * identifier. Quoting is indeed the one thing `extractQuoted` accepts whatever
 * the character set, but once both the memory and the query quote it the boost
 * stops meaning anything. On the real corpus above, two different quoted CJK
 * queries produced an identical boost profile — the same 7 memories of 45 at
 * the same scores, several of them containing no CJK at all — and one of them
 * put the maximum 0.500 on a memory about an entirely different Chinese term.
 * A signal that answers two different questions the same way carries no
 * information, and bare costs nothing by comparison.
 */
export const KEEP_IDENTIFIERS =
  "Preserve identifiers, file names, paths and commands verbatim, including CJK identifiers; add an English explanation for non-English identifiers.";
