# Local-memory MCP adapter: retrieval and read diagnostics

This page documents this checkout's `local-memory/` adapter. These tools are not hosted Mem0 API endpoints or additions to the upstream SDK. See the [adapter README](../local-memory/README.md) for installation and configuration.

## Opening retrieval

Search for one specific question about the current task without `kind`. For repository operations, also search `kind: "convention"` for rules relevant to building, testing, editing or committing. These queries can run in parallel. Search `kind: "decision"` when a design rationale is needed.

`kind` remains a strict filter with no automatic fallback. If results do not answer the question, change one factor and retry: split the question, add an identifier, omit kind or increase topK. Nonempty results do not prove relevance. Queries and memories remain English, with code identifiers preserved verbatim.

## Read tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `memory_get` | Required `id`; `scope` is `project` (default) or `all`; `includeExpired` defaults to false | Current memory record, using the same record fields as search/list |
| `memory_history` | Required `id`; optional integer `limit`, default 10, range 1–50 | `{record, truncated, entries}`; text history newest first |
| `memory_search` | Existing query options plus optional boolean `explain`, default false | Existing result wrapper; with explain enabled, records include `scoreDetails` |

`memory_get` accepts a full ID or an unambiguous prefix. Ambiguous prefixes and IDs absent from the requested visible scope return a tool error. Use `includeExpired: true` to inspect an expired record. Explicit `scope: "all"` permits reads across repositories owned by the configured user, but does not grant update or delete permission.

`memory_history` only reads the current repository, including expired records. Deleted records cannot be resolved through this tool, even if their history rows remain in storage. It reports text changes, not a complete audit of metadata. A truncated result means more rows exist; use `node src/cli.mjs history <id>` from the adapter directory for all accessible rows. Existing CLI behavior is unchanged.

For example, send this argument object to `memory_search`:

```json
{"query":"dsdebug _build_argv DS launch flags","topK":3,"explain":true}
```

Then pass an actual returned ID to `memory_get` or `memory_history`. `scoreDetails` exposes semantic, BM25 and entity contributions; it does not certify an exact identifier match or factual correctness, and enabling it does not change ordering.

For important corrections, inspect the current record, update it, and optionally check recall with an identifier query and a natural-language query. The update tool already reads the persisted record back. Ordinary writes do not automatically run these extra searches. A successful direct read confirms storage, not retrieval quality.

## Verification

Run `node scripts/test-mcp-reads.mjs` from `local-memory/`. The test copies an existing English embedding cache into a disposable data directory and exercises real MCP calls against mem0. It does not use production memories, an LLM or the reranker. Supply the model cache directory as the first argument if it is not in the default location. Add `--compat` to also run the existing MCP and CLI suites against a second disposable store.
