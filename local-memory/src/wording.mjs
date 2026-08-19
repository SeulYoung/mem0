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
  "Each memory is one self-contained statement that will still make sense months from now, stating the fact itself rather than the conversation it came from — aim for 15-80 words of prose across one to three sentences, and never exceed 120. Identifiers, paths, code spans and figures do not count towards that: keep every one of them, together with the symptom and the correct move, and cut the account of how you got there instead. Completeness beats brevity.";

/**
 * mem0's escape for a topic that does not fit — "split into multiple focused
 * memories rather than compressing details away" — spelled out as a second call,
 * because one `memory_add` stores exactly one memory and nothing else says so.
 */
export const SPLIT_NOT_COMPRESS =
  "A topic holding more detail than one memory fits is two memories rather than one compressed memory: `memory_add` stores exactly one, so call it again for each focused fact.";

/**
 * Not mem0's: mem0's own prompt imposes no language rule at all, so this layer
 * adds one. Why, and why it goes unopposed rather than overriding something, is
 * in `llm.customInstructions`.
 *
 * "Never enters", not "cannot be split". The difference is the whole mechanism:
 * `lemmatizeForBm25` keeps `/[a-z0-9]+/g`, so CJK is not an oversized token the
 * index failed to break up — it is absent. Both readings happen to discourage
 * writing CJK, which is why the wrong one survived here after being corrected
 * everywhere else, and it is also why `queryReachWarning` keys on the same
 * `[a-z0-9]` this sentence now describes.
 */
export const ENGLISH_ONLY =
  "Retrieval is English-only: the embedding model is English, and CJK text never enters the keyword index at all, so anything stored in another language is close to unreachable.";

/**
 * mem0's "Preserve Specific Details", narrowed to what a code repository's
 * memories turn on: identifiers are what the keyword and entity signals match on.
 *
 * The second sentence is not mem0's, and settles a collision this layer creates
 * on its own: `ENGLISH_ONLY` says CJK is unreachable, this rule says copy
 * identifiers verbatim, and a project whose table names and log strings are
 * Chinese hits both at once. Copying wins, because a translated identifier no
 * longer matches the code — but it buys nothing, and saying so is what stops an
 * agent expecting it to. Measured on this layer's own embedder: an English
 * sentence with a CJK identifier added still sits at 0.98 cosine from the same
 * sentence without it, so it barely moves;
 * `lemmatizeForBm25` matches /[a-z0-9]+/g, so CJK never reaches the keyword
 * index; and the entity route is not reachable from a CJK query at all, because
 * all four of mem0's extractors need an ASCII letter or a quote to fire.
 *
 * `bench-retrieval.mjs` measures the rule end to end rather than identifier by
 * identifier, and it holds: English questions that never name the CJK
 * identifier find the memory 3/3, because the English gloss alone lights up
 * both keyword and entity. Re-checked against 45 real memories in another
 * repository, 7 of which carry CJK identifiers an agent wrote under this rule:
 * 4/5 and 3/3 on the same two shapes of question. That script asserts both
 * halves of this and exits non-zero if either stops being true.
 *
 * What the gloss cannot rescue is a query that is *only* a CJK identifier. The
 * real corpus shows why more precisely than the fixture did: such a query
 * retrieves whichever memory holds the most CJK, not the one holding that
 * identifier — two different CJK queries both landed on the same unrelated
 * memory, the one with the most Chinese characters in the store. On an English
 * embedder a CJK-only query mostly encodes "this text is Chinese".
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
  "Keep identifiers, file names, paths and command names exactly as they appear: they are what the keyword and entity signals match on, and translating or reformatting one makes it unfindable. Copy an identifier that is itself CJK verbatim too — a translated one stops matching the code — but it reaches neither signal, so the English words that describe it have to be in the same sentence.";
