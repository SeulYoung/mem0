#!/usr/bin/env node
/**
 * Detached worker that writes a queued prompt into the memory store. Runs
 * outside the hook's lifetime so loading the embedding model never blocks the
 * editor. Queue files that fail are kept as `.failed` for inspection.
 */
import crypto from "node:crypto";
import fs from "node:fs";

import { loadConfig } from "../config.mjs";
import { isNestedAgentWorkspace } from "../llm.mjs";
import { addMemory, routeConsoleToStderr } from "../memory.mjs";
import { log } from "../paths.mjs";
import { resolveProject } from "../project.mjs";

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

  // Unreachable while the hook does its own check, but the invariant matters
  // enough to hold at the point of writing too: never store a summariser's own
  // prompt, or the next capture feeds the summariser forever.
  if (isNestedAgentWorkspace(project.root)) {
    fs.unlinkSync(queueFile);
    log("capture-worker", `dropped job from the summariser workspace: ${queueFile}`);
    process.exit(0);
  }

  // Nothing is waiting on this process, so this is the one place where paying
  // for a model call is free. Short prompts are already a single thought.
  const infer =
    Boolean(config.llm?.enabled) &&
    config.capture?.infer !== false &&
    job.text.length >= (config.capture?.inferMinChars ?? 25);
  const stored = await addMemory({
    text: job.text,
    project,
    kind: config.capture.kind ?? "prompt",
    source: "hook:beforeSubmitPrompt",
    infer,
    dedupeKey: crypto.createHash("md5").update(job.text).digest("hex"),
  });
  fs.unlinkSync(queueFile);
  log("capture-worker", `stored=${stored.length} from ${queueFile}`);
} catch (error) {
  log("capture-worker", `failed for ${queueFile}: ${error.stack ?? error.message}`);
  try {
    fs.renameSync(queueFile, `${queueFile}.failed`);
  } catch {
    // nothing else we can do
  }
  process.exit(1);
}
