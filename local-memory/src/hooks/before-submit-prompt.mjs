#!/usr/bin/env node
/**
 * Cursor `beforeSubmitPrompt` hook — the piece that makes capture unconditional.
 * It fires on every prompt the user sends, so recording does not depend on the
 * agent deciding to call a tool.
 *
 * With `capture.includeResponse` on, the prompt is parked as a turn in flight and
 * written only once the turn ends (`stop`), together with the agent's reply. Off,
 * or with no conversation id to pair on, it goes straight to a detached worker.
 * Either way the hook answers immediately: embedding must never sit between the
 * user and their request.
 */
import path from "node:path";

import { loadConfig } from "../config.mjs";
import { isNestedAgentInvocation, isNestedAgentWorkspace } from "../llm.mjs";
import { ensureDirs, log } from "../paths.mjs";
import { projectFromHookPayload } from "../project.mjs";
import { guardDeadline, readStdinJson, respond } from "./_hook-io.mjs";
import { beginTurn, flushTurn, queueJob, turnFile } from "./_turn-store.mjs";

const PROCEED = { continue: true };
guardDeadline(4000, PROCEED);

try {
  const payload = await readStdinJson();
  const config = loadConfig();
  const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  const project = projectFromHookPayload(payload);
  const file = turnFile(payload.conversation_id);

  const skip = (() => {
    // Capturing here would store the extraction prompt and trigger another
    // summarisation, which triggers another capture.
    if (isNestedAgentInvocation() || isNestedAgentWorkspace(project.root)) return "nested summarisation agent";
    if (!config.capture.enabled) return "capture disabled";
    if (!prompt) return "no prompt in payload";
    if (prompt.length < config.capture.minChars) return `shorter than ${config.capture.minChars} chars`;
    if (config.capture.skipPrefixes.some((prefix) => prefix && prompt.startsWith(prefix))) return "matched skipPrefixes";
    return null;
  })();

  if (skip) {
    log("capture", `skipped: ${skip}`);
    respond(PROCEED);
  }

  ensureDirs();
  const text = prompt.slice(0, config.capture.maxChars);

  // A turn still parked from the previous prompt never got its `stop`. Writing it
  // now, from whatever it collected, is the difference between "recorded late"
  // and "never recorded".
  flushTurn(file, "superseded by a new prompt");

  if (config.capture.includeResponse !== false && file) {
    beginTurn({ file, text, projectRoot: project.root, conversationId: payload.conversation_id ?? null });
    log("capture", `turn started ${path.basename(file)} project=${project.id} chars=${prompt.length}`);
    respond(PROCEED);
  }

  const queued = queueJob({
    prompt: text,
    responses: [],
    projectRoot: project.root,
    conversationId: payload.conversation_id ?? null,
    queuedAt: new Date().toISOString(),
  });
  log("capture", `queued ${path.basename(queued)} project=${project.id} chars=${prompt.length}`);
  respond(PROCEED);
} catch (error) {
  log("capture", `hook error (prompt still submitted): ${error.stack ?? error.message}`);
  respond(PROCEED);
}
