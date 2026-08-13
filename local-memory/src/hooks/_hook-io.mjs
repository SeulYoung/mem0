import { log } from "../paths.mjs";

/**
 * Cursor pipes a JSON payload to every hook on stdin. Never let a missing or
 * malformed payload turn into a hang: hooks that stall would stall the editor.
 */
export function readStdinJson(timeoutMs = 2000) {
  return new Promise((resolve) => {
    let raw = "";
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        // The Cursor CLI on Windows prefixes the payload with a UTF-8 BOM,
        // which JSON.parse rejects.
        const text = raw.replace(/^\uFEFF/, "").trim();
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        log("hook", `unparseable stdin payload: ${error.message}`);
        resolve({});
      }
    };

    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

/** Emit the hook response and leave. Exit code 0 tells Cursor to use the JSON. */
export function respond(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(0);
}

/**
 * Hard deadline for a hook process. Cursor fails open on timeout, but a hook
 * that lingers still costs the user time, so bail out with a safe answer.
 */
export function guardDeadline(ms, fallback) {
  const timer = setTimeout(() => {
    log("hook", `deadline of ${ms}ms exceeded; responding with fallback`);
    respond(fallback);
  }, ms);
  timer.unref();
  return timer;
}
