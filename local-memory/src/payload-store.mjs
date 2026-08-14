/**
 * Direct access to mem0's own SQLite payloads. The only file in this layer that
 * does, and the only one that may.
 *
 * Everything else here is an adapter: it reaches mem0 through its public API so
 * that upgrading the npm package cannot break us in a way a smoke test would
 * miss. This file is the exception, and it exists for exactly one reason:
 * `agent_id` is an identity key, and mem0 runs `stripIdentityKeys` over the
 * metadata handed to `update()`, so which repository an existing memory belongs
 * to cannot be changed through the public API at all. The alternative would be
 * delete-and-re-add, which mints a new id and a new createdAt — losing the two
 * things a memory is addressed by.
 *
 * So the rule is narrow rather than absent: this module only ever rewrites the
 * scoping keys of rows mem0 wrote, never creates a memory, never touches the
 * vectors, and never runs during normal operation — only from the maintenance
 * scripts, on demand, after a backup.
 *
 * What it relies on about mem0's storage (all verified against mem0ai 3.1.6's
 * `MemoryVectorStore`, and all of it visible in the first 200 lines of that
 * class):
 *   - one table, `vectors (id TEXT PRIMARY KEY, vector BLOB, payload TEXT)`
 *   - `payload` is flat JSON: metadata keys sit next to `data`, `hash`,
 *     `createdAt` and the identity keys, not nested under a `metadata` object
 *   - the entity index is the same schema in a sibling file, `*_entities.db`,
 *     whose payloads carry `linkedMemoryIds` back to the memories
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { PATHS } from "./paths.mjs";

export const VECTOR_DB = PATHS.vectorDb;
export const ENTITY_DB = PATHS.vectorDb.replace(/\.db$/, "_entities.db");

/**
 * Copy the file aside before rewriting it. Cheap insurance for a store measured
 * in megabytes, and the reason none of these scripts needs an undo path: the
 * backup is the undo path.
 *
 * The checkpoint first is not optional. These files are in WAL mode, so recently
 * committed rows may live only in the sidecar `-wal` file; copying the database
 * on its own would silently back up a state that is missing them.
 */
export function backup(file, db) {
  if (!fs.existsSync(file)) return null;
  try {
    db?.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // Another process is mid-write; the copy below is still a consistent
    // snapshot of everything checkpointed so far.
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${file}.bak-${stamp}`;
  fs.copyFileSync(file, target);
  return target;
}

async function openDb(file) {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(file);
  // WAL is how the rest of this layer opens these files; matching it keeps a
  // maintenance run from blocking a live Cursor window for the whole migration.
  db.pragma("journal_mode = WAL");
  // A live MCP server may hold the write lock for the length of one call. Wait
  // for it rather than failing the migration half way through.
  db.pragma("busy_timeout = 5000");
  return db;
}

/**
 * Every row of a store, payload already parsed. Reads the lot into memory on
 * purpose: a personal store is tens of thousands of rows at most, and holding
 * them means the caller can decide what to write after seeing everything —
 * which is what splitting an entity across repositories needs.
 */
export async function readRows(file) {
  if (!fs.existsSync(file)) return { rows: [], db: null };
  const db = await openDb(file);
  const rows = db
    .prepare("SELECT id, vector, payload FROM vectors")
    .all()
    .map((row) => ({ id: row.id, vector: row.vector, payload: JSON.parse(row.payload) }));
  return { rows, db };
}

/** Apply payload rewrites, inserts and deletes in one transaction. */
export function writeRows(db, { updated = [], inserted = [], deleted = [] }) {
  const update = db.prepare("UPDATE vectors SET payload = ? WHERE id = ?");
  const insert = db.prepare("INSERT OR REPLACE INTO vectors (id, vector, payload) VALUES (?, ?, ?)");
  const remove = db.prepare("DELETE FROM vectors WHERE id = ?");
  const run = db.transaction(() => {
    for (const row of updated) update.run(JSON.stringify(row.payload), row.id);
    for (const row of inserted) insert.run(row.id, row.vector, JSON.stringify(row.payload));
    for (const id of deleted) remove.run(id);
  });
  run();
}

/** For messages that name the file being rewritten. */
export function describe(file) {
  return `${path.basename(file)}${fs.existsSync(file) ? "" : " (missing)"}`;
}

/**
 * How many memories sit under each repository id, straight from the payloads.
 *
 * The only view that shows the ids rather than the names: `list` and `stats`
 * both print the repository *name*, which is the folder name and identical in
 * every clone. `legacy` marks a row still scoped the old way, by a `project`
 * metadata key mem0 knows nothing about — invisible to every ordinary read.
 */
export async function inventory() {
  const { rows, db } = await readRows(VECTOR_DB);
  const counts = new Map();
  for (const { payload } of rows) {
    const legacy = !payload.agent_id;
    const id = payload.agent_id ?? payload.project ?? "(unscoped)";
    const seen = counts.get(id) ?? { id, count: 0, name: null, legacy };
    counts.set(id, {
      id,
      count: seen.count + 1,
      name: seen.name ?? payload.project_name ?? null,
      legacy: seen.legacy || legacy,
    });
  }
  db?.close();
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

/**
 * Re-scope memories, and keep the entity index consistent with the result.
 *
 * `decide(payload)` returns the repository id a memory should belong to, or null
 * to leave it alone; both callers (the one-off migration and re-keying after a
 * remote change) differ only in that function.
 *
 * The entity index is the half that is easy to forget and impossible to ignore:
 * mem0 scopes its entity lookups by `agent_id` too, so an entity row left
 * untagged stops contributing its boost, and one tagged with the wrong
 * repository contributes it to the wrong search. Rows are tagged from the
 * memories they link to — and a row whose memories now belong to different
 * repositories has to become one row per repository, because a single row can
 * only carry one `agent_id`. Splitting reuses the stored vector, so no embedding
 * model is needed and the result is identical to what mem0 would have written.
 */
export async function retag({ decide, apply }) {
  const report = {
    memories: { scanned: 0, changed: 0, byTarget: {}, untouched: 0 },
    entities: { scanned: 0, tagged: 0, split: 0, orphaned: 0 },
    backups: [],
  };

  const { rows: memoryRows, db: memoryDb } = await readRows(VECTOR_DB);
  report.memories.scanned = memoryRows.length;
  const changed = [];
  /** Final owner of every memory, whether or not this run moved it. */
  const ownerOf = new Map();
  for (const row of memoryRows) {
    const target = decide(row.payload);
    if (target && target !== row.payload.agent_id) {
      row.payload.agent_id = target;
      changed.push(row);
      report.memories.byTarget[target] = (report.memories.byTarget[target] ?? 0) + 1;
    }
    if (row.payload.agent_id) ownerOf.set(row.id, row.payload.agent_id);
  }
  report.memories.changed = changed.length;
  report.memories.untouched = memoryRows.length - changed.length;

  const { rows: entityRows, db: entityDb } = await readRows(ENTITY_DB);
  report.entities.scanned = entityRows.length;
  const entityUpdates = [];
  const entityInserts = [];
  for (const row of entityRows) {
    const linked = Array.isArray(row.payload.linkedMemoryIds) ? row.payload.linkedMemoryIds : [];
    const groups = new Map();
    for (const memoryId of linked) {
      const owner = ownerOf.get(memoryId);
      if (!owner) continue;
      if (!groups.has(owner)) groups.set(owner, []);
      groups.get(owner).push(memoryId);
    }
    // Nothing to go on: the memories it linked are gone, or never got tagged.
    // Left as it is — an entity row mem0 cannot match is inert, and deleting
    // rows is not this function's business.
    if (groups.size === 0) {
      report.entities.orphaned += 1;
      continue;
    }
    const [first, ...rest] = [...groups];
    if (row.payload.agent_id !== first[0] || linked.length !== first[1].length) {
      row.payload.agent_id = first[0];
      row.payload.linkedMemoryIds = first[1];
      entityUpdates.push(row);
      report.entities.tagged += 1;
    }
    for (const [owner, memoryIds] of rest) {
      entityInserts.push({
        id: crypto.randomUUID(),
        vector: row.vector,
        payload: { ...row.payload, agent_id: owner, linkedMemoryIds: memoryIds },
      });
      report.entities.split += 1;
    }
  }

  if (apply && (changed.length > 0 || entityUpdates.length > 0 || entityInserts.length > 0)) {
    if (changed.length > 0) {
      report.backups.push(backup(VECTOR_DB, memoryDb));
      writeRows(memoryDb, { updated: changed });
    }
    if (entityUpdates.length > 0 || entityInserts.length > 0) {
      report.backups.push(backup(ENTITY_DB, entityDb));
      writeRows(entityDb, { updated: entityUpdates, inserted: entityInserts });
    }
  }
  memoryDb?.close();
  entityDb?.close();
  return report;
}
