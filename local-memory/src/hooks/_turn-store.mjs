/**
 * The turn in flight, shared by the three capture hooks.
 *
 * A turn is what mem0's `add()` actually wants: a `[user, assistant]` pair. But
 * the two halves arrive from different hooks, minutes apart, in different
 * processes — so the prompt is parked here when you send it, replies are
 * appended as they complete, and `stop` hands the finished turn to the queue.
 *
 * Append-only NDJSON rather than one JSON object that gets rewritten: an agent
 * turn can produce several assistant messages, each in its own hook process, and
 * read-modify-write between processes loses whichever write lands second.
 *
 * A turn file is short-lived by design. One that outlives its turn means the end
 * never came (window closed mid-answer), and two things flush it: the next prompt
 * in the same conversation, and the next session start.
 */
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PATHS, ensureDirs, log } from "../paths.mjs";

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "capture-worker.mjs");

/**
 * Conversation ids come from the host, so they are treated as untrusted input on
 * their way into a file name. Null when there is nothing usable: callers then
 * fall back to recording the prompt on its own, because without an id there is
 * no way to tell which turn a later reply belongs to.
 */
export function turnFile(conversationId) {
  const safe = String(conversationId ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .slice(0, 120);
  return safe ? path.join(PATHS.turnsDir, `${safe}.ndjson`) : null;
}

/** Hand a finished job to the detached worker. Nothing waits for it. */
export function queueJob(job) {
  ensureDirs();
  const file = path.join(PATHS.queueDir, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.json`);
  fs.writeFileSync(file, JSON.stringify(job));
  spawn(process.execPath, [WORKER, file], { detached: true, stdio: "ignore" }).unref();
  return file;
}

/** Park the prompt and start collecting replies for this conversation. */
export function beginTurn({ file, text, projectRoot, conversationId }) {
  ensureDirs();
  fs.writeFileSync(
    file,
    `${JSON.stringify({ t: "prompt", text, projectRoot, conversationId, at: new Date().toISOString() })}\n`,
  );
}

/**
 * Add one assistant message to the turn in flight, if there is one.
 *
 * `maxChars` is the budget for the whole reply, and this is the only place that
 * can see how much has already been written — so an agent that emits a hundred
 * messages stops growing the file rather than being trimmed later.
 */
export function appendResponse({ file, text, maxChars }) {
  // Only what the replies add up to, never the size of the file: the prompt line
  // can be `capture.maxChars` long on its own, and measuring the file would let a
  // long prompt silently reject every reply of its turn.
  let held = 0;
  try {
    if (fs.statSync(file).size > 4 * 1024 * 1024) return "turn file is implausibly large";
    const turn = readTurn(file);
    if (!turn) return "no turn in flight";
    held = turn.responses.reduce((total, reply) => total + reply.length, 0);
  } catch {
    return "no turn in flight";
  }
  // Some slack over the budget: the worker keeps the tail, so it is worth
  // holding a little more than will be used rather than exactly enough.
  const budget = Math.max(maxChars ?? 2000, 200) * 2;
  if (held >= budget) return `turn already holds ${held} chars of reply`;
  fs.appendFileSync(file, `${JSON.stringify({ t: "response", text })}\n`);
  return null;
}

/**
 * A captured turn as mem0's own `[user, assistant]` conversation, or null when
 * there is no reply to pair with the prompt.
 *
 * The **tail** of the reply is what is kept: an agent's answer opens with what it
 * is about to do and closes with what it found, and only the second half is worth
 * remembering. Several assistant messages in one turn are joined in order.
 */
export function turnMessages({ prompt, responses }, maxChars) {
  const joined = (responses ?? []).filter(Boolean).join("\n\n").trim();
  if (!prompt || !joined) return null;
  const budget = Math.max(maxChars ?? 2000, 200);
  return [
    { role: "user", content: prompt },
    { role: "assistant", content: joined.length > budget ? joined.slice(-budget) : joined },
  ];
}

/**
 * What the duplicate guard matches a captured turn on.
 *
 * Hashes exactly what mem0 is handed: the prompt alone when that is all that
 * gets stored, both halves when the turn goes through extraction. Keying on the
 * prompt alone would turn away the same question asked again with a better
 * answer this time, and mem0 would have mined that new half — its extraction is
 * shown the existing memories and asked only for what is new. An identical
 * replay still hashes the same, so it stays free.
 */
export function turnDedupeKey(prompt, messages) {
  const input = messages ? `${prompt}\n\n${messages[1].content}` : prompt;
  return crypto.createHash("md5").update(input).digest("hex");
}

function readTurn(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  let prompt = null;
  const responses = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.t === "prompt") prompt = entry;
      else if (entry.t === "response" && entry.text) responses.push(entry.text);
    } catch {
      // A torn final line means a hook was writing as we read. Everything before
      // it is still a valid turn, and dropping the last reply beats dropping all.
    }
  }
  return prompt ? { ...prompt, responses } : null;
}

/**
 * Turn a parked turn into a queued job. Removing the file first: a crash after
 * this point loses one memory, while leaving it would let the same turn be
 * recorded twice — and the input hash only catches that when the reply is
 * identical too.
 */
export function flushTurn(file, reason) {
  if (!file || !fs.existsSync(file)) return null;
  let turn = null;
  try {
    turn = readTurn(file);
  } catch (error) {
    log("capture", `unreadable turn ${path.basename(file)}: ${error.message}`);
  }
  try {
    fs.unlinkSync(file);
  } catch {
    // already gone
  }
  if (!turn) return null;
  const queued = queueJob({
    prompt: turn.text,
    responses: turn.responses,
    projectRoot: turn.projectRoot,
    conversationId: turn.conversationId ?? null,
    queuedAt: new Date().toISOString(),
  });
  log(
    "capture",
    `flushed turn ${path.basename(file)} (${reason}): replies=${turn.responses.length} -> ${path.basename(queued)}`,
  );
  return queued;
}

/**
 * Flush turns that will never end on their own. Called from `sessionStart`
 * because it is the one hook that runs when nothing else is happening, and a
 * prompt stuck here is a memory silently not taken.
 */
export function flushStaleTurns(maxAgeMs) {
  let flushed = 0;
  let names = [];
  try {
    names = fs.readdirSync(PATHS.turnsDir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of names) {
    if (!name.endsWith(".ndjson")) continue;
    const file = path.join(PATHS.turnsDir, name);
    try {
      if (fs.statSync(file).mtimeMs > cutoff) continue;
    } catch {
      continue;
    }
    if (flushTurn(file, "timed out")) flushed += 1;
  }
  return flushed;
}
