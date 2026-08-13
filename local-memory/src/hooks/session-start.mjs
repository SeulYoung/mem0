#!/usr/bin/env node
/**
 * Cursor `sessionStart` hook. Injects what was learned in earlier sessions for
 * this repository, plus a short protocol telling the agent how to use the
 * memory tools. `additional_context` is the only documented way to get text
 * into a fresh conversation, so retrieval happens here rather than per prompt.
 *
 * Hosts that never run hooks are covered by the second channel instead — see
 * `../injection.mjs`.
 */
import { ensureConfigFile } from "../config.mjs";
import { buildInjectionText } from "../injection.mjs";
import { isNestedAgentInvocation } from "../llm.mjs";
import { routeConsoleToStderr } from "../memory.mjs";
import { log } from "../paths.mjs";
import { projectFromHookPayload } from "../project.mjs";
import { guardDeadline, readStdinJson, respond } from "./_hook-io.mjs";

routeConsoleToStderr();

const EMPTY = {};
guardDeadline(8000, EMPTY);

// The summarisation model runs as a nested agent inside a scratch workspace;
// injecting memories there would only waste tokens on its own extraction task.
if (isNestedAgentInvocation()) respond(EMPTY);

try {
  const payload = await readStdinJson();
  const config = ensureConfigFile();

  if (!config.inject.enabled || config.inject.hookContext === false) respond(EMPTY);

  const project = projectFromHookPayload(payload);
  const { text, count } = await buildInjectionText({ project, config });

  log("session-start", `project=${project.id} injected=${count}`);
  respond({ additional_context: text });
} catch (error) {
  log("session-start", `hook error (session continues): ${error.stack ?? error.message}`);
  respond(EMPTY);
}
