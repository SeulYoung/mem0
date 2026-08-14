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
 * Every claim is mem0's, from `ADDITIVE_EXTRACTION_PROMPT`'s "Memory Quality
 * Standards". mem0 exports no prompts, so `scripts/test-prompts.mjs` reads the
 * installed bundle instead and fails when one of them is no longer in it.
 */

/**
 * mem0's "Concise but Complete" standard: the 15-80 band, the 100-word
 * allowance for detail-rich content, the three-sentence case, and the rule that
 * completeness outranks the count.
 */
export const MEMORY_LENGTH =
  "Each memory is one self-contained statement of 15-80 words that will still make sense months from now, stating the fact itself rather than the conversation it came from — up to 100 words and up to three sentences when it carries several identifiers, figures or enumerated items. Completeness beats brevity: never drop an identifier, path, date or figure to meet the count.";

/**
 * mem0's escape for a topic that does not fit — "split into multiple focused
 * memories rather than compressing details away" — spelled out as a second call,
 * because one `memory_add` stores exactly one memory and nothing else says so.
 */
export const SPLIT_NOT_COMPRESS =
  "A topic holding more detail than one memory fits is two memories rather than one compressed memory: `memory_add` stores exactly one, so call it again for each focused fact.";

/**
 * Not mem0's: mem0 asks for the input's language. Why this layer reverses that,
 * and why the reversal goes unopposed, is in `llm.customInstructions`.
 */
export const ENGLISH_ONLY =
  "Retrieval is English-only: the embedding model is English, and the keyword index cannot split CJK text into words at all, so anything stored in another language is close to unreachable.";

/**
 * mem0's "Preserve Specific Details", narrowed to what a code repository's
 * memories turn on: identifiers are what the keyword and entity signals match on.
 */
export const KEEP_IDENTIFIERS =
  "Keep identifiers, file names, paths and command names exactly as they appear: they are what the keyword and entity signals match on, and translating or reformatting one makes it unfindable.";
