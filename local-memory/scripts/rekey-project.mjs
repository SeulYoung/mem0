#!/usr/bin/env node
/**
 * Move memories from one repository id to another.
 *
 * resolveProject() prefers the git origin slug and only falls back to the folder
 * hash, so adding, removing or changing a remote gives the same repository a new
 * id. Nothing migrates the rows written under the old one: they keep the old
 * `agent_id` and quietly drop out of search and injection. This is the repair.
 *
 *   node scripts/rekey-project.mjs                            # inventory
 *   node scripts/rekey-project.mjs --from <old-id>            # dry run
 *   node scripts/rekey-project.mjs --from <old-id> --yes      # apply
 *
 * `--to` defaults to whatever the current working directory resolves to. Only
 * the scoping keys are rewritten — ids, dates, kinds, expiries and the text are
 * untouched — so the same command with --from and --to swapped undoes it.
 *
 * This works on the stored payloads rather than through mem0's API, because
 * `agent_id` is one of the identity keys mem0's `update()` refuses to change.
 * See src/payload-store.mjs for why that is allowed to be the exception.
 */
import { inventory, retag } from "../src/payload-store.mjs";
import { asEntityId, resolveProject } from "../src/project.mjs";

const out = (line = "") => process.stdout.write(`${line}\n`);

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

const fromId = typeof flag("from") === "string" ? flag("from") : null;

// Without --from, take an inventory instead of failing: nothing else surfaces
// the raw ids, so "which one do I migrate from" is unanswerable otherwise.
if (!fromId) {
  const here = resolveProject();
  out("repository ids in the store:");
  for (const { id, count, name, legacy } of await inventory()) {
    const label = name && name !== id ? `  (${name})` : "";
    out(`  ${count.toString().padStart(4)}  ${id}${label}${legacy ? "  [not scoped as agent_id — run migrate-to-agent-scope.mjs]" : ""}`);
  }
  out("");
  out(`this directory resolves to: ${here.id}${here.remote ? "" : "  (no git remote — fallback id)"}`);
  out("pass --from <id> to move one of them.");
  process.exit(0);
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
const toId = asEntityId(explicitTo ?? current.id);
if (toId === fromId) throw new Error(`--from and --to are both "${fromId}"; nothing to do.`);

const apply = flag("yes") === true;
const report = await retag({
  // Legacy rows are matched too: before the move to `agent_id` the same id lived
  // in a `project` metadata key, and a store that was never migrated should
  // still be re-keyable in one step.
  decide: (payload) => ((payload.agent_id ?? payload.project) === fromId ? toId : null),
  apply,
});

out(`from  ${fromId}`);
out(`to    ${toId}`);
out(`found ${report.memories.changed} memories`);
if (report.memories.changed === 0) {
  out("nothing matched that id — run without --from to see which ids the store holds.");
  process.exit(0);
}
out(
  `      entity index: ${report.entities.tagged} rows re-tagged, ${report.entities.split} split off for another repository`,
);

if (!apply) {
  out("");
  out("dry run — re-run with --yes to rewrite them.");
  process.exit(0);
}

out("");
out(`moved ${report.memories.changed} memories to ${toId}`);
for (const file of report.backups.filter(Boolean)) out(`backup ${file}`);
