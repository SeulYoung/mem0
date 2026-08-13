import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { PATHS, ensureDirs, log } from "./paths.mjs";

/**
 * Cursor has no OpenAI-compatible inference endpoint — its documented APIs are
 * Admin/Analytics (the `crsr_` keys) and the asynchronous Cloud Agents API. The
 * only synchronous "prompt in, text out" path is the Cursor CLI in print mode,
 * so that is what this bridge drives.
 */
const DEFAULT_MODEL = "claude-sonnet-5-low";

const DEFAULT_MAX_CALLS_PER_DAY = 200;

/**
 * The summariser is itself a Cursor agent, so it inherits the user-level MCP and
 * hook wiring — including ours. Left alone it would start a second memory server
 * and capture its own extraction prompt as a memory, which then triggers another
 * summarisation. This marker travels in the child's environment and every entry
 * point of ours checks it first.
 */
export const INTERNAL_ENV_MARKER = "MEM0_LOCAL_INTERNAL";

export function isNestedAgentInvocation() {
  return process.env[INTERNAL_ENV_MARKER] === "1";
}

/**
 * Cursor starts MCP servers without passing our marker down, so the nested agent
 * is also recognised by where it runs: an empty scratch directory of ours that no
 * real repository can live in.
 */
export const LLM_WORKSPACE = path.join(PATHS.home, "llm-workspace");

export function isNestedAgentWorkspace(dir) {
  if (!dir) return false;
  const resolved = path.resolve(dir);
  return resolved === LLM_WORKSPACE || resolved.startsWith(LLM_WORKSPACE + path.sep);
}

function scratchWorkspace() {
  fs.mkdirSync(LLM_WORKSPACE, { recursive: true });
  return LLM_WORKSPACE;
}

/**
 * Every call bills real tokens to the Cursor account, and prompt capture fires
 * on its own. A daily ceiling turns a runaway loop into verbatim storage instead
 * of a surprise invoice. Concurrent workers may undercount slightly; the point
 * is the order of magnitude, not exact accounting.
 */
function claimDailyBudget(limit) {
  const file = path.join(PATHS.home, "llm-usage.json");
  const today = new Date().toISOString().slice(0, 10);
  let usage = { day: today, calls: 0 };
  try {
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    if (onDisk.day === today) usage = onDisk;
  } catch {
    // first call of the day
  }
  if (usage.calls >= limit) {
    throw new Error(`Daily model budget reached (${limit} calls). Raise llm.maxCallsPerDay to allow more.`);
  }
  usage.calls += 1;
  try {
    fs.writeFileSync(file, `${JSON.stringify(usage)}\n`);
  } catch {
    // budget tracking is best effort
  }
  return usage.calls;
}

function pathEntries() {
  return (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).filter(Boolean);
}

/**
 * Resolve how to launch the CLI. The shipped `cursor-agent.cmd` only exists to
 * locate `node.exe` + `index.js` and hand over; doing that lookup ourselves
 * skips two interpreter startups and keeps stdin a plain pipe instead of one
 * routed through cmd.exe.
 */
function resolveCommand(configured) {
  if (configured) {
    return { exe: configured, prefix: [], kind: "configured" };
  }

  for (const dir of pathEntries()) {
    const hasWrapper = ["cursor-agent.ps1", "cursor-agent.cmd", "cursor-agent"].some((name) =>
      fs.existsSync(path.join(dir, name)),
    );
    if (!hasWrapper) continue;

    const direct = directNodeEntry(dir);
    if (direct) return direct;

    // No bundled runtime found next to the wrapper: fall back to it and accept
    // the tighter command line budget.
    const wrapper = ["cursor-agent.ps1", "cursor-agent.cmd", "cursor-agent"]
      .map((name) => path.join(dir, name))
      .find((file) => fs.existsSync(file));
    if (wrapper.endsWith(".ps1")) {
      return {
        exe: "powershell.exe",
        prefix: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapper],
        kind: "powershell-wrapper",
      };
    }
    return { exe: wrapper, prefix: [], kind: "wrapper", viaShell: wrapper.endsWith(".cmd") };
  }

  return { exe: "cursor-agent", prefix: [], kind: "path-lookup", viaShell: process.platform === "win32" };
}

/** Mirror of the wrapper's lookup: a sibling runtime, or the newest `versions/<v>/`. */
function directNodeEntry(dir) {
  const candidates = [dir];
  const versionsDir = path.join(dir, "versions");
  try {
    const versions = fs
      .readdirSync(versionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    candidates.push(...versions.map((name) => path.join(versionsDir, name)));
  } catch {
    // no versions directory — only the flat layout applies
  }

  for (const candidate of candidates) {
    const node = ["node.exe", "node"].map((n) => path.join(candidate, n)).find((f) => fs.existsSync(f));
    const entry = path.join(candidate, "index.js");
    if (node && fs.existsSync(entry)) {
      return { exe: node, prefix: [entry], kind: "bundled-node" };
    }
  }
  return null;
}

/** `env:NAME` keeps the token in the environment instead of on disk. */
export function resolveApiKey(llmConfig) {
  const raw = llmConfig?.apiKey;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const trimmed = raw.trim();
  if (trimmed.startsWith("env:")) {
    const name = trimmed.slice(4).trim();
    return process.env[name] || undefined;
  }
  return trimmed;
}

function roleOf(message) {
  if (typeof message?._getType === "function") {
    const type = message._getType();
    if (type === "human") return "user";
    if (type === "ai") return "assistant";
    return type;
  }
  return message?.role ?? "user";
}

function contentOf(message) {
  const content = message?.content;
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
}

/**
 * Flatten a chat exchange into the single prompt the CLI accepts. The agent
 * already runs under its own system prompt, so mem0's instructions travel as
 * part of the turn. Content is passed through verbatim — only headings are
 * added, so mem0's prompt engineering stays intact.
 */
function buildPrompt(messages) {
  const sections = [];
  for (const message of messages ?? []) {
    const role = roleOf(message);
    const content = contentOf(message);
    if (!content.trim()) continue;
    sections.push(role === "system" ? `# Instructions\n\n${content}` : `# Input (${role})\n\n${content}`);
  }
  sections.push("# Response rules\n\nOutput only the JSON described above, with no prose before or after it.");
  return sections.join("\n\n");
}

/**
 * Whether a reply plausibly carries the JSON mem0 asked for. Used only as a
 * gate: the raw text is what gets returned, because mem0's own `extractJson` is
 * a string-aware brace matcher and is the authority on parsing. A false negative
 * here is safe — it surfaces as an error, and the caller stores the memory
 * verbatim instead of losing it.
 */
function carriesJson(text) {
  const unfenced = String(text ?? "").replace(/```(?:\w+)?\n?([\s\S]*?)(?:```|$)/g, "$1").trim();
  for (const candidate of [unfenced, sliceOutermost(unfenced)]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return true;
    } catch {
      // try the next candidate
    }
  }
  return false;
}

function sliceOutermost(text) {
  const first = text.search(/[{[]/);
  const last = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  return first >= 0 && last > first ? text.slice(first, last + 1) : "";
}

/** `--output-format json` prints one envelope; be tolerant about extra lines. */
function parseEnvelope(stdout) {
  const lines = String(stdout).split(/\r?\n/).filter((line) => line.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === "object" && parsed.type === "result") return parsed;
    } catch {
      // not this line
    }
  }
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // not JSON at all
  }
  return null;
}

export function createCursorCliLlm(llmConfig) {
  const model = llmConfig?.model || DEFAULT_MODEL;
  const timeoutMs = Number(llmConfig?.timeoutMs) > 0 ? Number(llmConfig.timeoutMs) : 120000;
  const maxCallsPerDay =
    Number(llmConfig?.maxCallsPerDay) > 0 ? Number(llmConfig.maxCallsPerDay) : DEFAULT_MAX_CALLS_PER_DAY;
  const command = resolveCommand(llmConfig?.command);
  const apiKey = resolveApiKey(llmConfig);

  async function run(prompt) {
    ensureDirs();
    const workspace = scratchWorkspace();
    claimDailyBudget(maxCallsPerDay);

    // No positional prompt: the CLI reads it from stdin instead. That matters
    // for more than the 32767-character Windows command line that mem0's ~34000
    // character extraction prompt does not fit into. The alternative — writing
    // the prompt to a file and telling the agent to carry out its instructions —
    // makes mem0's system prompt arrive as *file content*, and the agent
    // regularly refuses it as a prompt-injection attempt ("that file isn't a
    // legitimate task specification"), which silently degrades every capture to
    // verbatim storage. Over stdin it is the turn itself, so there is nothing to
    // mistrust and mem0's prompt reaches the model unaltered.
    const args = [
      ...command.prefix,
      "--print",
      "--output-format",
      "json",
      "--model",
      model,
      // Read-only mode plus an empty workspace: the summarizer cannot touch any repository.
      "--mode",
      "ask",
      "--trust",
      "--workspace",
      workspace,
    ];

    const env = {
      ...process.env,
      [INTERNAL_ENV_MARKER]: "1",
      NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE || path.join(PATHS.home, "cli-compile-cache"),
    };
    if (apiKey) env.CURSOR_API_KEY = apiKey;

    return invokeCli(args, env, workspace, prompt);
  }

  function invokeCli(args, env, workspace, prompt) {
    return new Promise((resolve, reject) => {
      const child = spawn(command.exe, args, {
        cwd: workspace,
        env,
        windowsHide: true,
        shell: Boolean(command.viaShell),
      });

      child.stdin.on("error", () => {
        // The close handler already reports whatever the CLI did instead of reading.
      });
      child.stdin.end(prompt, "utf8");

      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Cursor CLI timed out after ${timeoutMs}ms (model=${model}).`));
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`Cannot launch Cursor CLI (${command.exe}): ${error.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const envelope = parseEnvelope(stdout);

        if (!envelope) {
          const detail = (stderr || stdout || "no output").trim().slice(0, 400);
          reject(new Error(`Cursor CLI returned no parsable result (exit ${code}): ${detail}`));
          return;
        }
        if (envelope.is_error || typeof envelope.result !== "string") {
          reject(new Error(`Cursor CLI reported an error: ${String(envelope.result ?? "unknown").slice(0, 400)}`));
          return;
        }

        const usage = envelope.usage ?? {};
        log(
          "llm",
          `model=${model} duration_ms=${envelope.duration_ms ?? "?"} tokens_in=${usage.inputTokens ?? "?"} ` +
            `tokens_out=${usage.outputTokens ?? "?"} cache_read=${usage.cacheReadTokens ?? "?"} cache_write=${usage.cacheWriteTokens ?? "?"}`,
        );

        // Refusing garbage here is what turns "model went off script" into a
        // verbatim save instead of a memory that silently never gets written.
        if (!carriesJson(envelope.result)) {
          reject(new Error(`Model replied without any JSON: ${envelope.result.trim().slice(0, 200)}`));
          return;
        }
        resolve(envelope.result);
      });
    });
  }

  return {
    /**
     * The shape mem0's `langchain` LLM provider expects: an object with
     * `invoke` that returns something carrying a string `content`. Deliberately
     * without `withStructuredOutput` / `bindTools` so mem0 stays on its plain
     * text path and parses the JSON with its own `extractJson`.
     */
    async invoke(messages) {
      const content = await run(buildPrompt(Array.isArray(messages) ? messages : [messages]));
      return { content };
    },

    /** Read by mem0 purely for log labels. */
    model,

    info: {
      provider: "cursor-cli",
      model,
      executable: command.exe,
      resolution: command.kind,
      apiKey: apiKey ? "configured" : "cli-login",
      timeoutMs,
      maxCallsPerDay,
    },

    async probe() {
      const started = Date.now();
      const text = await run('Reply with exactly this JSON and nothing else: {"ok": true}');
      return { ok: text.includes('"ok"'), ms: Date.now() - started, reply: text.slice(0, 120) };
    },
  };
}

/** Returns null when no LLM is configured, so callers can stay on verbatim storage. */
export function createLlm(config) {
  const llmConfig = config?.llm ?? {};
  if (!llmConfig.enabled) return null;

  const provider = llmConfig.provider ?? "cursor-cli";
  if (provider === "cursor-cli") return createCursorCliLlm(llmConfig);
  if (provider === "openai" || provider === "openai-compatible") return null; // handled natively by mem0
  throw new Error(`Unknown llm.provider "${provider}". Use "cursor-cli" or "openai".`);
}
