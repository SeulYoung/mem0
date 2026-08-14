#!/usr/bin/env node
/**
 * Detached worker that writes a captured turn into the memory store. Runs
 * outside the hook's lifetime so loading the embedding model never blocks the
 * editor. Queue files that fail are kept as `.failed` for inspection.
 */
import fs from "node:fs";

import { loadConfig } from "../config.mjs";
import { isNestedAgentWorkspace } from "../llm.mjs";
import { addMemory, routeConsoleToStderr } from "../memory.mjs";
import { log } from "../paths.mjs";
import { resolveProject } from "../project.mjs";
import { turnDedupeKey, turnMessages } from "./_turn-store.mjs";

routeConsoleToStderr();

const queueFile = process.argv[2];
if (!queueFile) {
  log("capture-worker", "called without a queue file");
  process.exit(1);
}

try {
  const job = JSON.parse(fs.readFileSync(queueFile, "utf8"));
  const config = loadConfig();
  const project = resolveProject(job.projectRoot);
  // `text` is what jobs queued before turn pairing carry.
  const prompt = job.prompt ?? job.text ?? "";

  // Unreachable while the hook does its own check, but the invariant matters
  // enough to hold at the point of writing too: never store a summariser's own
  // prompt, or the next capture feeds the summariser forever.
  if (isNestedAgentWorkspace(project.root)) {
    fs.unlinkSync(queueFile);
    log("capture-worker", `dropped job from the summariser workspace: ${queueFile}`);
    process.exit(0);
  }

  // The turn as mem0's own `[user, assistant]` conversation, which is both what
  // its extraction prompt is written for and what decides whether there is
  // enough here to be worth a model call.
  const pair = turnMessages(job, config.capture?.maxResponseChars ?? 2000);
  const turnChars = prompt.length + (pair ? pair[1].content.length : 0);

  // Nothing is waiting on this process, so this is the one place where paying
  // for a model call is free. Measured over the whole turn: a two-word question
  // with a substantial answer is still worth extracting.
  const infer =
    Boolean(config.llm?.enabled) && config.capture?.infer !== false && turnChars >= (config.capture?.inferMinChars ?? 25);

  // Only with the model: the verbatim path stores one memory per message, which
  // would put a whole agent reply in the store as a memory of its own.
  const messages = infer ? pair : null;

  const stored = await addMemory({
    text: prompt,
    messages,
    project,
    kind: config.capture.kind ?? "prompt",
    source: messages ? "hook:turn" : "hook:beforeSubmitPrompt",
    infer,
    dedupeKey: turnDedupeKey(prompt, messages),
  });
  fs.unlinkSync(queueFile);
  log(
    "capture-worker",
    `stored=${stored.length} reply=${messages ? messages[1].content.length : 0} from ${queueFile}`,
  );
} catch (error) {
  log("capture-worker", `failed for ${queueFile}: ${error.stack ?? error.message}`);
  try {
    fs.renameSync(queueFile, `${queueFile}.failed`);
  } catch {
    // nothing else we can do
  }
  process.exit(1);
}
