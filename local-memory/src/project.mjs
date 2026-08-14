import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The id is handed to mem0 as `agent_id`, which it refuses if it contains
 * whitespace — and a folder named "My Project" would otherwise mint one. Folded
 * here, at the single place an id is minted, so no caller has to remember.
 */
export function asEntityId(value) {
  return value.replace(/\s+/g, "-");
}

function readGitRemote(root) {
  // Parsed by hand so this works without a git binary on PATH.
  try {
    const gitPath = path.join(root, ".git");
    let configPath = path.join(gitPath, "config");
    const stat = fs.statSync(gitPath);
    if (stat.isFile()) {
      const link = fs.readFileSync(gitPath, "utf8").match(/gitdir:\s*(.+)/);
      if (!link) return null;
      configPath = path.join(path.resolve(root, link[1].trim()), "config");
    }
    const text = fs.readFileSync(configPath, "utf8");
    const section = text.match(/\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/);
    const url = section?.[1].match(/url\s*=\s*(.+)/);
    return url ? url[1].trim() : null;
  } catch {
    return null;
  }
}

/** github.com/mem0ai/mem0.git -> mem0ai/mem0 */
function slugFromRemote(remote) {
  const cleaned = remote
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/^[^@]+@/, "")
    .replace(/:/g, "/")
    .replace(/\.git$/i, "");
  const parts = cleaned.split("/").filter(Boolean);
  return parts.slice(-2).join("/").toLowerCase() || null;
}

/**
 * Identify the repository the current session belongs to.
 * A git remote is preferred so memories survive moving or re-cloning the folder;
 * otherwise we fall back to the folder name plus a hash of its absolute path.
 */
export function resolveProject(explicitRoot) {
  const root = path.resolve(
    explicitRoot || process.env.CURSOR_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd(),
  );
  const name = path.basename(root) || root;
  const remote = readGitRemote(root);
  const slug = remote ? slugFromRemote(remote) : null;
  const id = asEntityId(
    slug || `${name.toLowerCase()}-${crypto.createHash("sha1").update(root.toLowerCase()).digest("hex").slice(0, 8)}`,
  );
  return { id, name, root, remote: remote ?? null };
}

/** Pull the workspace root out of a Cursor hook payload, with env/cwd fallbacks. */
export function projectFromHookPayload(payload) {
  const roots = payload?.workspace_roots;
  const root = Array.isArray(roots) && roots.length > 0 ? roots[0] : undefined;
  return resolveProject(root);
}
