#!/usr/bin/env node
/**
 * Small maintenance CLI for the local memory store — inspect, add, search and
 * prune without going through Cursor.
 *
 *   node src/cli.mjs doctor
 *   node src/cli.mjs add "..." [--kind preference] [--expires 2026-12-31] [--force]
 *   node src/cli.mjs search "..." [--all] [--top 5] [--explain] [--no-rerank]
 *   node src/cli.mjs list [--all] [--limit 20]
 *   node src/cli.mjs stats
 *   node src/cli.mjs update <id> ["new text"] [--kind k] [--expires 2026-12-31] [--clear-expiry]
 *   node src/cli.mjs history <id>
 *   node src/cli.mjs delete <id>
 *   node src/cli.mjs prune --kind prompt --days 30 [--yes]
 *   node src/cli.mjs prune --expired [--days 30] [--yes]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureConfigFile, loadConfig } from "./config.mjs";
import {
  SWEEP_TASK,
  WATCHDOG_TASK,
  describeChanges,
  fingerprint,
  formatAge,
  readHeartbeat,
  readJson,
  readToolFailure,
  writeJsonAtomic,
} from "./health.mjs";
import {
  KINDS,
  addMemory,
  deleteMemory,
  historyMemory,
  listMemories,
  openMemory,
  routeConsoleToStderr,
  searchMemories,
  statsMemories,
  updateMemory,
} from "./memory.mjs";
import { PATHS } from "./paths.mjs";
import { resolveProject } from "./project.mjs";
import { rerankerConfig, rerankerProblem } from "./reranker.mjs";
import { taskRegistered } from "./scheduled-task.mjs";

routeConsoleToStderr();

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Maintenance reads the whole store rather than a page of it: mem0's `list` has
 * no ORDER BY and `getAll` truncates with slice, so any smaller limit returns
 * the oldest records instead of the newest.
 */
const SCAN_ALL = 10000;

const argv = process.argv.slice(2);
const command = argv[0];

// Switches take no value. Declaring them is what lets `search --all "query"`
// keep its query instead of consuming it as the value of `--all`.
const SWITCHES = new Set([
  "all",
  "explain",
  "infer",
  "yes",
  "no-notify",
  "clear-expiry",
  "expired",
  "force",
  "no-rerank",
]);

function flag(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  if (SWITCHES.has(name)) return true;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

// Everything that is neither a flag nor a flag's value. Skipping values matters:
// without it, `add "text" --kind convention` would store "text convention",
// because the value is just another bare token.
const positional = [];
for (let index = 1; index < argv.length; index += 1) {
  const token = argv[index];
  if (!token.startsWith("--")) {
    positional.push(token);
    continue;
  }
  const next = argv[index + 1];
  if (!SWITCHES.has(token.slice(2)) && next && !next.startsWith("--")) index += 1;
}

const out = (value) => process.stdout.write(typeof value === "string" ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`);
const project = resolveProject(flag("project-dir", undefined));
const scope = flag("all", false) ? "all" : "project";

function renderRecords(records) {
  if (records.length === 0) return out("(none)");
  for (const record of records) {
    const score = record.score === undefined ? "" : ` score=${record.score.toFixed(3)}`;
    // Exponential because the cross-encoder is decisive: the scores that matter
    // here span several orders of magnitude, and fixed decimals show them all as
    // 0.000.
    const reranked = record.rerankScore === undefined ? "" : ` rerank=${record.rerankScore.toExponential(2)}`;
    const from = record.attributedTo ? ` from=${record.attributedTo}` : "";
    const expiry = record.expiresAt ? ` expires=${record.expiresAt}` : "";
    out(
      `${record.id.slice(0, 8)}  [${record.kind ?? "note"}] ${record.projectName ?? "-"}${score}${reranked}${from}${expiry}\n    ${record.text}`,
    );
    // mem0 fuses semantic + BM25 keyword + entity boost; --explain shows which fired.
    if (record.scoreDetails) {
      const parts = Object.entries(record.scoreDetails)
        .filter(([, value]) => typeof value === "number")
        .map(([key, value]) => `${key}=${value.toFixed(3)}`);
      out(`    signals: ${parts.join("  ")}`);
    }
  }
}

function describeReranker(config) {
  // "off" is a legitimate setting and an unusable provider is not, so they must
  // not print the same way — this is the only place the difference shows.
  if (config.reranker?.enabled) {
    const problem = rerankerProblem(config);
    if (problem) return `MISCONFIGURED: ${problem}`;
  }
  const reranker = rerankerConfig(config);
  if (!reranker) return "off — search returns mem0's fused ranking unchanged";
  const cached = fs.existsSync(PATHS.rerankerCache) && fs.readdirSync(PATHS.rerankerCache).length > 0;
  try {
    import.meta.resolve("@huggingface/transformers");
  } catch {
    return `${reranker.provider} configured, but @huggingface/transformers is not installed — run: npm install`;
  }
  return `${reranker.provider} (model ${cached ? `cached in ${PATHS.rerankerCache}` : "downloads on first search, ~87MB"})`;
}

async function doctor() {
  const config = ensureConfigFile();
  out(`node                ${process.version}`);
  out(`data directory      ${PATHS.home}`);
  out(`config file         ${PATHS.configFile}`);
  out(`vector store        ${PATHS.vectorDb}${fs.existsSync(PATHS.vectorDb) ? "" : "  (not created yet)"}`);
  out(`memory owner        ${config.userId}`);
  out(`embedder            ${config.embedder.provider} / ${config.embedder.model}`);
  // The reranker is the one component that stays silent when it is missing —
  // mem0 falls back to the fused order and the search still answers — so the
  // only place its absence shows up is here.
  out(`reranker            ${describeReranker(config)}`);
  out(`current project     ${project.name} -> ${project.id}`);

  // Probe the model for real: the cached dimension would hide a broken embedder.
  const { embedder, llm } = await openMemory();
  const started = Date.now();
  const vector = await embedder.embedQuery("doctor probe 健康检查");
  out(`embedding dimension ${vector.length} (live probe took ${Date.now() - started}ms)`);

  if (!config.llm?.enabled) {
    out("summarisation model disabled — memories are stored verbatim, fully offline");
  } else if (!llm) {
    out(`summarisation model ${config.llm.provider} / ${config.llm.model} via ${config.llm.baseURL ?? "default endpoint"}`);
  } else {
    out(`summarisation model ${llm.info.model} via ${llm.info.resolution} (${llm.info.executable})`);
    out(`model credentials   ${llm.info.apiKey === "configured" ? "config apiKey" : "whoever the Cursor CLI is logged in as"}`);
    try {
      const probe = await llm.probe();
      out(`model live probe    ${probe.ok ? "ok" : `unexpected reply: ${probe.reply}`} (${probe.ms}ms)`);
    } catch (error) {
      out(`model live probe    FAILED: ${error.message}`);
      out("                    captures still work — they fall back to storing the text verbatim");
    }
  }

  const stats = await statsMemories();
  out(`memories stored     ${stats.total}`);

  // Expired memories are hidden from search but still on disk, and mem0's
  // keyword pass does not filter them, so they go on affecting the divisor that
  // visible results are normalised by. `stats.expired` is mem0's own count; the
  // extra scan for how many the sweep would now take is only paid when there is
  // something to say.
  const grace = config.prune?.expiredGraceDays ?? 30;
  let expired = `${stats.expired}`;
  if (stats.expired > 0) {
    const cutoff = new Date(Date.now() - grace * DAY_MS).toISOString().slice(0, 10);
    const due = (await listMemories({ project, limit: SCAN_ALL, scope: "all", includeExpired: true })).filter(
      (record) => record.expiresAt && record.expiresAt.slice(0, 10) < cutoff,
    );
    expired += ` hidden, ${due.length} past the ${grace}-day window`;
  }
  out(`expired memories    ${expired}`);

  const channels = config.inject.enabled
    ? [
        config.inject.hookContext === false ? null : "sessionStart hook",
        config.inject.mcpInstructions === false ? null : "mcp instructions",
      ].filter(Boolean)
    : [];
  out(`session injection   ${channels.length > 0 ? channels.join(" + ") : "off"}`);

  const cursorDir = path.join(os.homedir(), ".cursor");
  for (const [label, file, needle] of [
    ["cursor mcp.json", path.join(cursorDir, "mcp.json"), "mem0-local"],
    ["cursor hooks.json", path.join(cursorDir, "hooks.json"), "local-memory/src/hooks"],
  ]) {
    let state = "missing — run: npm run install-cursor";
    try {
      state = fs.readFileSync(file, "utf8").includes(needle) ? "wired up" : "present but not wired — run: npm run install-cursor";
    } catch {
      // keep default
    }
    out(`${label.padEnd(20)}${state}`);
  }

  const failed = fs.existsSync(PATHS.queueDir)
    ? fs.readdirSync(PATHS.queueDir).filter((name) => name.endsWith(".failed"))
    : [];
  out(`failed captures     ${failed.length === 0 ? "none" : `${failed.length} in ${PATHS.queueDir}`}`);

  // A turn parked here is a prompt that has not been recorded yet. One or two is
  // normal (a conversation with a reply still coming); a pile means `stop` is not
  // firing, and every one of them is a memory not taken.
  if (config.capture?.includeResponse !== false) {
    const parked = fs.existsSync(PATHS.turnsDir)
      ? fs.readdirSync(PATHS.turnsDir).filter((name) => name.endsWith(".ndjson"))
      : [];
    const timeout = config.capture?.turnTimeoutMinutes ?? 120;
    const stale = parked.filter((name) => {
      try {
        return Date.now() - fs.statSync(path.join(PATHS.turnsDir, name)).mtimeMs > timeout * 60 * 1000;
      } catch {
        return false;
      }
    });
    let state = parked.length === 0 ? "none" : `${parked.length} in flight`;
    if (stale.length > 0) state += `, ${stale.length} past the ${timeout}-minute timeout`;
    out(`turns awaiting end  ${state}`);
  }

  reportHealth();
  out(`log file            ${PATHS.logFile}`);
}

/** Is the task still registered? An uninstalled unattended job is silent by definition. */
function taskState(name, installer) {
  if (process.platform !== "win32") return "only installable on Windows";
  return taskRegistered(name) ? "registered" : `not installed — run: npm run ${installer}`;
}

function reportHealth() {
  const heartbeat = readHeartbeat();
  if (!heartbeat) {
    out("last session        never — no MCP session has started since health tracking was added");
  } else {
    const store = heartbeat.store === "ok" ? "store ok" : `store ${heartbeat.store}`;
    out(`last session        ${formatAge(heartbeat.at)}  ${heartbeat.project}  ${store}`);
    out(`  ran on            ${heartbeat.nodeVersion} (ABI ${heartbeat.abi}) via ${heartbeat.host}`);
    const changes = describeChanges(heartbeat, fingerprint());
    // Comparing against this CLI's own runtime is only meaningful as a hint —
    // the IDE launches the server with its own node, not with this one.
    if (changes.length > 0) out(`  since then         ${changes.join("; ")}`);
  }

  const watchdog = readJson(PATHS.watchdogFile);
  const verdict = !watchdog
    ? "never run"
    : watchdog.status === "ok"
      ? `all ${watchdog.checked?.length ?? 0} runtime(s) ok ${formatAge(watchdog.at)}`
      : `PROBLEM ${formatAge(watchdog.at)}`;
  out(`watchdog            ${verdict}; scheduled task ${taskState(WATCHDOG_TASK, "install-watchdog")}`);
  if (watchdog?.status === "problem") for (const problem of watchdog.problems ?? []) out(`  ${problem.message}`);
  for (const runtime of watchdog?.checked ?? []) {
    out(`  probed            ${runtime.runtime}: ${runtime.ok ? `ok in ${runtime.ms}ms` : `FAILED ${runtime.error}`}`);
  }

  const sweep = readJson(PATHS.sweepFile);
  const swept = sweep ? `${formatAge(sweep.at)}, deleted ${sweep.deleted}` : "never run";
  out(`monthly sweep       ${swept}; scheduled task ${taskState(SWEEP_TASK, "install-sweeper")}`);

  const toolError = readToolFailure();
  if (toolError) out(`last tool error     ${formatAge(toolError.at)}  ${toolError.tool}: ${toolError.message}`);
}

/**
 * Two modes, and `--days` counts from a different event in each: for captured
 * prompts from when they were stored, for expired memories from their expiry
 * date. Only the expired mode runs unattended, from the monthly sweep task.
 */
async function prune() {
  const expiredMode = Boolean(flag("expired", false));
  const grace = loadConfig().prune?.expiredGraceDays ?? 30;
  const days = Number(flag("days", expiredMode ? grace : 30));
  const kind = flag("kind", "prompt");

  let doomed;
  let what;
  if (expiredMode) {
    // Expiry dates are stored as YYYY-MM-DD, so comparing them as strings
    // against a date-only cutoff keeps this clear of timezone arithmetic.
    const cutoff = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
    doomed = (await listMemories({ project, limit: SCAN_ALL, scope: "all", includeExpired: true })).filter(
      (record) => record.expiresAt && record.expiresAt.slice(0, 10) < cutoff,
    );
    what = `memories whose expiry date passed more than ${days} days ago`;
  } else {
    const cutoff = Date.now() - days * DAY_MS;
    doomed = (await listMemories({ project, limit: SCAN_ALL, scope: "all" })).filter(
      (record) => record.kind === kind && record.createdAt && Date.parse(record.createdAt) < cutoff,
    );
    what = `memories of kind "${kind}" older than ${days} days`;
  }

  out(`${doomed.length} ${what}`);
  if (!flag("yes", false)) {
    if (doomed.length === 0) return;
    renderRecords(doomed.slice(0, 10));
    return out(`\nRe-run with --yes to delete all ${doomed.length}.`);
  }

  // Deletion is scoped to the repository that owns the memory, so hand each
  // record back under its own owner rather than under the current directory.
  for (const record of doomed) {
    await deleteMemory(record.id, { id: record.project, name: record.projectName ?? record.project });
  }
  // The sweep runs hidden and monthly, so the run itself has to be recorded:
  // "swept, nothing was due" and "has not swept since you installed it" are
  // different states, and doctor is the only place you would notice.
  if (expiredMode) {
    writeJsonAtomic(PATHS.sweepFile, { at: new Date().toISOString(), deleted: doomed.length, graceDays: days });
  }
  if (doomed.length > 0) out(`Deleted ${doomed.length}.`);
}

switch (command) {
  case "doctor":
    await doctor();
    break;
  case "add": {
    const text = positional.join(" ");
    if (!text) {
      throw new Error(
        'Usage: node src/cli.mjs add "the memory text" [--kind preference] [--infer] [--expires YYYY-MM-DD] [--force]',
      );
    }
    const stored = await addMemory({
      text,
      project,
      kind: flag("kind", "note"),
      source: "cli",
      infer: Boolean(flag("infer", false)),
      expiresAt: flag("expires", null),
      dedupe: !flag("force", false),
    });
    renderRecords(stored);
    break;
  }
  case "search": {
    const query = positional.join(" ");
    if (!query) {
      throw new Error(
        'Usage: node src/cli.mjs search "what you are looking for" [--all] [--top 5] [--explain] [--no-rerank] [--threshold 0.2]',
      );
    }
    const threshold = flag("threshold", null);
    const top = flag("top", null);
    renderRecords(
      await searchMemories({
        query,
        project,
        // Null leaves `search.topK` in charge, like the memory_search tool does.
        topK: top === null ? null : Number(top),
        scope,
        explain: Boolean(flag("explain", false)),
        // Both null unless asked for, which is what leaves the configured
        // behaviour in charge.
        rerank: flag("no-rerank", false) ? false : null,
        threshold: threshold === null ? null : Number(threshold),
      }),
    );
    break;
  }
  case "list":
    renderRecords(
      await listMemories({
        project,
        limit: Number(flag("limit", 20)),
        scope,
        includeExpired: Boolean(flag("expired", false)),
      }),
    );
    break;
  case "stats":
    out(await statsMemories());
    break;
  case "update": {
    const id = positional[0];
    // Everything after the id is the replacement text, so quoting it is optional.
    const text = positional.slice(1).join(" ");
    const kind = flag("kind", undefined);
    const expires = flag("expires", undefined);
    if (!id || (!text && !kind && !expires && !flag("clear-expiry", false))) {
      throw new Error(
        'Usage: node src/cli.mjs update <id> ["new text"] [--kind k] [--expires YYYY-MM-DD] [--clear-expiry]',
      );
    }
    renderRecords([
      await updateMemory({
        id,
        project,
        ...(text ? { text } : {}),
        ...(kind ? { kind } : {}),
        ...(flag("clear-expiry", false) ? { expiresAt: null } : expires ? { expiresAt: expires } : {}),
      }),
    ]);
    break;
  }
  case "history": {
    const id = positional[0];
    if (!id) throw new Error("Usage: node src/cli.mjs history <id>");
    const { record, entries } = await historyMemory({ id, project });
    // The full uuid, unlike everywhere else: this is where you would copy it out
    // of, having found the memory by its short id.
    out(`${record.id}  [${record.kind ?? "note"}] ${record.projectName ?? "-"}\n    ${record.text}`);
    // mem0 writes an ADD row for every memory it stores, so an empty log has
    // only one cause: this memory was written before the current history file.
    // Installs from before repositories became `agent_id` kept one change log
    // per repository, and those files are still there, unread.
    if (entries.length === 0) {
      out(`\n(nothing recorded in ${PATHS.historyDb} — this memory predates it,`);
      out(`and its rows are in the per-repository files under ${path.join(PATHS.home, "history")})`);
    }
    for (const entry of entries) {
      // Only an UPDATE row records when it happened. An ADD row carries the
      // memory's creation date, and a DELETE row carries no date at all.
      out(`\n${entry.action}  ${entry.updatedAt ?? entry.createdAt ?? "(no date recorded)"}`);
      if (entry.previous) out(`  was  ${entry.previous}`);
      if (entry.next) out(`  now  ${entry.next}`);
    }
    break;
  }
  case "delete": {
    const id = positional[0];
    if (!id) throw new Error("Usage: node src/cli.mjs delete <id>");
    out(await deleteMemory(id, project));
    break;
  }
  case "prune":
    await prune();
    break;
  case "watch": {
    // Imported here so that every other command stays clear of the MCP client.
    const { runWatchdog } = await import("./watchdog.mjs");
    const verdict = await runWatchdog({
      verbose: true,
      notifications: !flag("no-notify", false),
    });
    // A non-zero exit is what makes this usable from any other scheduler too.
    if (verdict.status === "problem") process.exitCode = 1;
    break;
  }
  case "config":
    out(loadConfig());
    break;
  default:
    out(
      [
        "Local memory CLI",
        "",
        "  doctor                          health check of store, embedder, model and Cursor wiring",
        '  add "text" [--kind k] [--infer] [--expires YYYY-MM-DD] [--force]',
        "                                  store a memory (--infer distils it through the model,",
        "                                  --force stores it despite a near-identical existing one)",
        `                                  kinds: ${KINDS.join(" | ")} — see DESIGN.md for what each one means`,
        '  search "query" [--all] [--top n] [--explain] [--no-rerank] [--threshold t]',
        "                                  search; --explain shows each retrieval signal",
        "  list [--all] [--limit n] [--expired]   newest memories first; --expired also shows expired ones",
        "  stats                           counts by repository and kind",
        '  update <id> ["new text"] [--kind k] [--expires YYYY-MM-DD] [--clear-expiry]',
        "                                  correct a memory in place, keeping its id and original date",
        "  history <id>                    every change mem0 recorded for one memory, newest first,",
        "                                  including the text an update replaced",
        "  delete <id>                     delete one memory owned by this repository",
        "  prune [--kind prompt] [--days 30] [--yes]   drop captured prompts older than --days",
        "  prune --expired [--days 30] [--yes]         drop memories expired for that many days",
        "                                  without --yes both prune modes only list what they would delete",
        "  watch [--no-notify]             start the memory server under every IDE runtime and alert if it fails",
        "  config                          print the effective configuration",
      ].join("\n"),
    );
}