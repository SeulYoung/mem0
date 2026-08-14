#!/usr/bin/env node
/**
 * One-off migration: move existing memories from this layer's own `project`
 * metadata key into mem0's `agent_id`.
 *
 * Which repository a memory belongs to used to be a metadata key of ours. It
 * worked for the vector filter and for nothing else — mem0's entity index and
 * its replayed `## Last k Messages` are scoped by `agent_id`, which we were not
 * setting, so both had to be worked around. Memories written before that change
 * are invisible to every scoped read until they are re-stamped, which is what
 * this does. It is idempotent: rows that already carry an `agent_id` are left
 * alone, so running it twice is harmless.
 *
 *   node scripts/migrate-to-agent-scope.mjs          # report only
 *   node scripts/migrate-to-agent-scope.mjs --yes    # apply
 *
 * Global memories (`project: "global"`) have nowhere to go: an `agent_id` holds
 * one value and mem0 accepts one per query, so "visible in every repository" is
 * not expressible any more. They are reported and skipped; give them a home with
 * `--global-to <repository-id>` if you want to keep them.
 *
 * Writes payloads directly, because `agent_id` is one of the identity keys mem0's
 * `update()` refuses to change — see src/payload-store.mjs.
 */
import { inventory, retag } from "../src/payload-store.mjs";
import { asEntityId } from "../src/project.mjs";

const out = (line = "") => process.stdout.write(`${line}\n`);

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

const GLOBAL = "global";
const globalTo = typeof flag("global-to") === "string" ? asEntityId(flag("global-to")) : null;
const apply = flag("yes") === true;

out("before:");
for (const { id, count, name, legacy } of await inventory()) {
  out(`  ${count.toString().padStart(4)}  ${id}${name && name !== id ? `  (${name})` : ""}${legacy ? "  [legacy]" : ""}`);
}
out("");

let skippedGlobal = 0;
const report = await retag({
  decide: (payload) => {
    if (payload.agent_id) return null;
    if (!payload.project) return null;
    if (payload.project === GLOBAL) {
      if (globalTo) return globalTo;
      skippedGlobal += 1;
      return null;
    }
    // Folded the same way resolveProject() folds a fresh id, or a repository
    // whose folder name contains a space would migrate to an id mem0 rejects.
    return asEntityId(payload.project);
  },
  apply,
});

out(`memories        ${report.memories.scanned} scanned, ${report.memories.changed} to re-stamp`);
for (const [id, count] of Object.entries(report.memories.byTarget).sort((a, b) => b[1] - a[1])) {
  out(`  ${count.toString().padStart(4)}  -> ${id}`);
}
out(
  `entity index    ${report.entities.scanned} rows: ${report.entities.tagged} to tag, ${report.entities.split} to split between repositories, ${report.entities.orphaned} left alone`,
);
if (skippedGlobal > 0) {
  out("");
  out(`${skippedGlobal} global memories skipped — they are invisible until they belong to a repository.`);
  out("Re-run with --global-to <repository-id> to move them into one (the ids are listed above).");
}

if (!apply) {
  out("");
  out("report only — re-run with --yes to apply.");
  process.exit(0);
}

out("");
for (const file of report.backups.filter(Boolean)) out(`backup ${file}`);
out("after:");
for (const { id, count, name, legacy } of await inventory()) {
  out(`  ${count.toString().padStart(4)}  ${id}${name && name !== id ? `  (${name})` : ""}${legacy ? "  [legacy]" : ""}`);
}
