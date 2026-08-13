#!/usr/bin/env node
/**
 * Move memories from one repository id to another.
 *
 * resolveProject() prefers the git origin slug and only falls back to the
 * folder hash, so adding, removing or changing a remote gives the same
 * repository a new id. Nothing migrates the rows that were written under the
 * old one: they keep their `metadata.project` and quietly drop out of search
 * and injection. This is the repair.
 *
 *   node scripts/rekey-project.mjs --from <old-id>            # dry run
 *   node scripts/rekey-project.mjs --from <old-id> --yes      # apply
 *
 * `--to` defaults to whatever the current working directory resolves to.
 * Only the text metadata is rewritten; ids, dates, kinds and expiries are
 * left alone, so the same command with --from and --to swapped undoes it.
 */
import { detectDimension, listMemories, openMemory, routeConsoleToStderr } from "../src/memory.mjs";
import { GLOBAL_SCOPE, resolveProject } from "../src/project.mjs";

routeConsoleToStderr();

const SCAN_LIMIT = 100000;
const out = (line = "") => process.stdout.write(`${line}\n`);

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

const fromId = typeof flag("from") === "string" ? flag("from") : null;

// Nothing else surfaces the raw ids: `list` and `stats` both show the project
// *name*, which is just the folder name and is the same for every clone. So
// without --from, take an inventory instead of failing.
if (!fromId) {
  const here = resolveProject();
  const all = await listMemories({ project: here, limit: SCAN_LIMIT, scope: "all", includeExpired: true });
  const counts = new Map();
  for (const record of all) {
    const key = record.project ?? "unknown";
    const seen = counts.get(key) ?? { count: 0, name: record.projectName };
    counts.set(key, { count: seen.count + 1, name: seen.name ?? record.projectName });
  }
  out("repository ids in the store:");
  for (const [id, { count, name }] of [...counts].sort((a, b) => b[1].count - a[1].count)) {
    out(`  ${count.toString().padStart(4)}  ${id}${name && name !== id ? `  (${name})` : ""}`);
  }
  out("");
  out(`this directory resolves to: ${here.id}${here.remote ? "" : "  (no git remote — fallback id)"}`);
  out("pass --from <id> to move one of them.");
  process.exit(0);
}
if (fromId === GLOBAL_SCOPE) {
  throw new Error("Global memories belong to every repository; use `update --scope project` for one of them instead.");
}

const explicitTo = typeof flag("to") === "string" ? flag("to") : null;
const current = resolveProject();
// Without --to we would inherit whatever the shell happens to be sitting in,
// and npm run puts that inside local-memory/ — a folder with no remote of its
// own, which resolves to a hash id that belongs to no repository.
if (!explicitTo && !current.remote) {
  throw new Error(
    `${current.root} has no git remote, so it resolves to the fallback id "${current.id}". ` +
      "Run this from the repository root, or name the target with --to <id>.",
  );
}
const to = { id: explicitTo ?? current.id, name: null };
const explicitName = typeof flag("to-name") === "string" ? flag("to-name") : null;
to.name = explicitName ?? (to.id === current.id ? current.name : to.id);
if (to.id === fromId) throw new Error(`--from and --to are both "${fromId}"; nothing to do.`);

const from = { id: fromId, name: fromId };
const apply = flag("yes") === true;

// Read through the old project so mem0 opens that repository's history file,
// the one where these records' change log already lives.
const { memory } = await openMemory(from);
const records = (
  await listMemories({ project: from, limit: SCAN_LIMIT, scope: "project", includeExpired: true })
).filter((record) => record.project === fromId);

out(`from  ${fromId}`);
out(`to    ${to.id} (${to.name})`);
out(`found ${records.length} memories`);
if (records.length === 0) process.exit(0);

const byKind = {};
for (const record of records) byKind[record.kind ?? "unknown"] = (byKind[record.kind ?? "unknown"] ?? 0) + 1;
out(`      ${Object.entries(byKind).map(([kind, count]) => `${kind} ${count}`).join(", ")}`);

if (!apply) {
  out("");
  out("dry run — re-run with --yes to rewrite metadata.project on these records.");
  process.exit(0);
}

await detectDimension();
let moved = 0;
const failures = [];
for (const record of records) {
  try {
    // Metadata is merged, so kind, source, source_hash and any expiry survive.
    await memory.update(record.id, { metadata: { project: to.id, project_name: to.name } });
    moved += 1;
  } catch (error) {
    failures.push(`${record.id.slice(0, 8)}: ${error.message}`);
  }
}

const left = (await listMemories({ project: to, limit: SCAN_LIMIT, scope: "project", includeExpired: true })).filter(
  (record) => record.project === to.id,
).length;

out("");
out(`moved ${moved}/${records.length}`);
out(`${to.id} now holds ${left} memories`);
for (const failure of failures) out(`FAILED ${failure}`);
process.exit(failures.length > 0 ? 1 : 0);
