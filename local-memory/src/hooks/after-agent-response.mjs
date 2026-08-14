#!/usr/bin/env node
/**
 * Cursor `afterAgentResponse` hook — the other half of a turn.
 *
 * Everything worth remembering from a turn is usually in the answer, not in the
 * question: the cause of the crash, the script that has to run first, the reason
 * an approach was dropped. Without this hook the extraction model only ever sees
 * one side and those conclusions are lost unless the agent thinks to call
 * `memory_add` itself.
 *
 * It only appends to the turn parked by `beforeSubmitPrompt`; the write happens
 * once, at `stop`. One agent turn can complete several assistant messages, so
 * this fires more than once per turn and all of them belong to the same turn.
 */
import path from "node:path";

import { loadConfig } from "../config.mjs";
import { isNestedAgentInvocation, isNestedAgentWorkspace } from "../llm.mjs";
import { log } from "../paths.mjs";
import { projectFromHookPayload } from "../project.mjs";
import { guardDeadline, readStdinJson, respond } from "./_hook-io.mjs";
import { appendResponse, turnFile } from "./_turn-store.mjs";

const EMPTY = {};
guardDeadline(4000, EMPTY);

try {
  const payload = await readStdinJson();
  const config = loadConfig();
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  const project = projectFromHookPayload(payload);
  const file = turnFile(payload.conversation_id);

  const skip = (() => {
    // The summariser is an agent too, and its answer is the JSON we asked it for.
    if (isNestedAgentInvocation() || isNestedAgentWorkspace(project.root)) return "nested summarisation agent";
    if (!config.capture.enabled) return "capture disabled";
    if (config.capture.includeResponse === false) return "capture.includeResponse is off";
    if (!text) return "empty reply";
    if (!file) return "no conversation id to pair on";
    return null;
  })();

  if (skip) {
    log("capture", `reply ignored: ${skip}`);
    respond(EMPTY);
  }

  const rejected = appendResponse({ file, text, maxChars: config.capture.maxResponseChars ?? 2000 });
  log(
    "capture",
    rejected
      ? `reply ignored: ${rejected}`
      : `reply added to ${path.basename(file)} project=${project.id} chars=${text.length}`,
  );
  respond(EMPTY);
} catch (error) {
  log("capture", `afterAgentResponse hook error (ignored): ${error.stack ?? error.message}`);
  respond(EMPTY);
}
