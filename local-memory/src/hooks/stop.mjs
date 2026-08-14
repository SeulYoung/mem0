#!/usr/bin/env node
/**
 * Cursor `stop` hook — where a turn becomes a memory.
 *
 * This is the moment both halves of the turn exist, so it is the moment the pair
 * can be handed to mem0 as the `[user, assistant]` conversation its extraction
 * prompt is written for. The work itself happens in a detached worker; this hook
 * only moves the parked turn into the queue.
 *
 * Aborted and errored turns are written too. The prompt was real, and a reply cut
 * short is still evidence of what was being worked on.
 *
 * It deliberately never returns `followup_message`: this hook exists to observe a
 * finished turn, and answering here would start another one.
 */
import { isNestedAgentInvocation, isNestedAgentWorkspace } from "../llm.mjs";
import { log } from "../paths.mjs";
import { projectFromHookPayload } from "../project.mjs";
import { guardDeadline, readStdinJson, respond } from "./_hook-io.mjs";
import { flushTurn, turnFile } from "./_turn-store.mjs";

const EMPTY = {};
guardDeadline(4000, EMPTY);

try {
  const payload = await readStdinJson();
  const project = projectFromHookPayload(payload);
  const file = turnFile(payload.conversation_id);

  if (isNestedAgentInvocation() || isNestedAgentWorkspace(project.root)) {
    log("capture", "turn end ignored: nested summarisation agent");
    respond(EMPTY);
  }
  // Not gated on capture.enabled or includeResponse: whatever is parked was
  // parked while they were on, and dropping it on a config change would lose it.
  if (!file) {
    log("capture", "turn end ignored: no conversation id");
    respond(EMPTY);
  }

  const queued = flushTurn(file, `turn ${payload.status ?? "ended"}`);
  if (!queued) log("capture", "turn end: nothing parked for this conversation");
  respond(EMPTY);
} catch (error) {
  log("capture", `stop hook error (ignored): ${error.stack ?? error.message}`);
  respond(EMPTY);
}
