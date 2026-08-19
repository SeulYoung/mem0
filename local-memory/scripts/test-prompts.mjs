#!/usr/bin/env node
/**
 * Keeps this layer's prompt text honest about mem0's.
 *
 * The agent-facing texts restate a contract that lives upstream, because the
 * default write path is verbatim and never runs mem0's extraction prompt. mem0
 * exports no prompts, so the restatement cannot be generated from one — but the
 * text is in the shipped bundle, so drift can be detected: every claim
 * `wording.mjs` restates is still in mem0's prompt, the absence the English-only
 * policy leans on still holds, and every site still composes the shared claims.
 *
 * Reading a dependency's bundle is confined to this file, and failing loudly when
 * it moves is the point. Free and deterministic — no store, no model.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.mjs";
import { MEMORY_PROTOCOL } from "../src/injection.mjs";
import { memoryTools } from "../src/tools.mjs";
import { ENGLISH_ONLY, KEEP_IDENTIFIERS, MEMORY_LENGTH, SPLIT_NOT_COMPRESS } from "../src/wording.mjs";

const out = (line) => process.stdout.write(`${line}\n`);

let failures = 0;
const check = (label, ok, detail) => {
  out(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

// Resolved through the package rather than a guessed path, so a hoisted or
// relocated install is followed instead of silently skipped.
const bundlePath = fileURLToPath(import.meta.resolve("mem0ai/oss"));
const bundle = fs.readFileSync(bundlePath, "utf8");
out(`mem0 bundle: ${bundlePath} (${Math.round(bundle.length / 1024)} KB)`);

/**
 * The sentences mem0's ADDITIVE_EXTRACTION_PROMPT states and this layer repeats.
 * Each is paired with what would silently go wrong here if mem0 dropped it.
 *
 * Two of them this layer now restates with a change rather than verbatim — see
 * `MEMORY_LENGTH` — but they are still asserted, because the change is a
 * deliberate departure from a standard that exists, and it stops being that the
 * moment the standard does.
 */
const UPSTREAM_CLAIMS = [
  ["15-80 words", "the band this layer keeps, having changed only what is counted"],
  ["up to 100 for detail-rich content", "the allowance this layer's 120-word cap replaces"],
  ["completeness beats brevity", "the priority rule — without it the count outranks the content"],
  ["up to 3 for content with multiple proper nouns", "the three-sentence allowance memory_update used to contradict"],
  ["split into multiple focused memories", "the escape this layer renders as a second memory_add call"],
  ["### Self-Contained", "the standard the tools call self-contained"],
  ["Your sole operation is ADD", "what memory_update means by memory_add only ever adding"],
  ["## Custom Instructions", "the slot llm.customInstructions arrives in, and its priority"],
];

for (const [claim, why] of UPSTREAM_CLAIMS) {
  check(`mem0 still states: ${claim}`, bundle.includes(claim), why);
}

/**
 * Neither OSS build imposes a language of its own. The TS port has no
 * `useInputLanguage` parameter, and the Python builder's `## Language
 * Requirement` block — which calls translating into English CRITICAL to avoid —
 * sits behind a flag `Memory.add` never passes. That absence is load-bearing: it
 * is why `llm.customInstructions` can ask for English without arguing with the
 * system prompt above it. What is read here is the TS bundle, so this guards the
 * build this layer actually runs on. If any of these appears, the policy needs
 * rethinking rather than repeating.
 */
const LANGUAGE_MARKERS = ["SAME LANGUAGE", "detect the language", "Language Requirement", "in the same language"];
for (const marker of LANGUAGE_MARKERS) {
  check(
    `mem0 still imposes no language of its own: ${marker}`,
    !bundle.includes(marker),
    "the English-only policy in llm.customInstructions would now be contradicting mem0's own prompt",
  );
}

/**
 * The two places this layer knowingly departs from mem0. Both look like tidy-up
 * bait — an odd counting unit, a sentence about Chinese in a rule about
 * identifiers — and deleting either one restores a contradiction rather than a
 * simplification: without the first the count is spent on paths, and without
 * the second `ENGLISH_ONLY` and `KEEP_IDENTIFIERS` give opposite instructions
 * for a repository whose table names are Chinese.
 */
check(
  "the length rule still counts prose only, and still names a ceiling",
  /do not count towards that/.test(MEMORY_LENGTH) && /120/.test(MEMORY_LENGTH),
  MEMORY_LENGTH,
);
check(
  "the identifier rule still settles the case where the identifier is itself CJK",
  /CJK/.test(KEEP_IDENTIFIERS),
  KEEP_IDENTIFIERS,
);

// --- and every site still says it the same way -------------------------------

const tools = memoryTools(loadConfig());
const tool = (name) => tools.find((entry) => entry.name === name);
const add = tool("memory_add");
const search = tool("memory_search");
const update = tool("memory_update");

check(
  "the injected protocol carries the length rule verbatim",
  MEMORY_PROTOCOL.includes(MEMORY_LENGTH) && MEMORY_PROTOCOL.includes(SPLIT_NOT_COMPRESS),
);
check(
  "memory_add's description carries the same length rule",
  add.description.includes(MEMORY_LENGTH) && add.description.includes(SPLIT_NOT_COMPRESS),
);
check(
  "the language rule is shared by the protocol and both text-bearing tools",
  MEMORY_PROTOCOL.includes(ENGLISH_ONLY) &&
    add.inputSchema.properties.text.description.includes(ENGLISH_ONLY) &&
    search.inputSchema.properties.query.description.includes(ENGLISH_ONLY),
);
check(
  "so is the identifier rule, which is what the keyword and entity signals need",
  MEMORY_PROTOCOL.includes(KEEP_IDENTIFIERS) &&
    add.inputSchema.properties.text.description.includes(KEEP_IDENTIFIERS) &&
    search.inputSchema.properties.query.description.includes(KEEP_IDENTIFIERS),
);

// memory_update writes the same field as memory_add, and the drift that started
// this suite was it asking for a single "sentence" where mem0 allows three. It
// points at memory_add rather than restating, so what is asserted is the pointer.
const updateText = update.inputSchema.properties.text.description;
check(
  "memory_update points at memory_add instead of restating its own length rule",
  updateText.includes("memory_add describes") && !/\bsentence\b/.test(updateText),
  updateText,
);

/**
 * The one prompt that must NOT share these sentences: `llm.customInstructions`
 * is appended to mem0's own extraction prompt, so anything mem0 already says
 * belongs there once — in mem0's copy, not in a second one below it.
 */
const custom = loadConfig().llm?.customInstructions ?? "";
check(
  "llm.customInstructions does not repeat mem0's length rule back at mem0",
  !custom.includes("15-80") && !custom.includes("beats brevity"),
  custom.slice(0, 80),
);

out(failures === 0 ? "\nPrompt text agrees with mem0." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
