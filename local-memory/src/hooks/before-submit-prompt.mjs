#!/usr/bin/env node
/**
 * Cursor `beforeSubmitPrompt` hook — the piece that makes capture unconditional.
 * It fires on every prompt the user sends, so recording does not depend on the
 * agent deciding to call a tool.
 *
 * The prompt is queued and handed to a detached worker, then the hook answers
 * immediately: embedding must never sit between the user and their request.
 */
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../config.mjs";
import { isNestedAgentInvocation, isNestedAgentWorkspace } from "../llm.mjs";
import { PATHS, ensureDirs, log } from "../paths.mjs";
import { projectFromHookPayload } from "../project.mjs";
import { guardDeadline, readStdinJson, respond } from "./_hook-io.mjs";

const PROCEED = { continue: true };
guardDeadline(4000, PROCEED);

try {
  const payload = await readStdinJson();
  const config = loadConfig();
  const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  const project = projectFromHookPayload(payload);

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
  const queueFile = path.join(PATHS.queueDir, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.json`);
  fs.writeFileSync(
    queueFile,
    JSON.stringify({
      text: prompt.slice(0, config.capture.maxChars),
      projectRoot: project.root,
      conversationId: payload.conversation_id ?? null,
      queuedAt: new Date().toISOString(),
    }),
  );

  const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), "capture-worker.mjs");
  spawn(process.execPath, [worker, queueFile], { detached: true, stdio: "ignore" }).unref();

  log("capture", `queued ${path.basename(queueFile)} project=${project.id} chars=${prompt.length}`);
  respond(PROCEED);
} catch (error) {
  log("capture", `hook error (prompt still submitted): ${error.stack ?? error.message}`);
  respond(PROCEED);
}
