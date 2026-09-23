# Local-memory MCP adapter: retrieval and read diagnostics

This page documents this checkout's `local-memory/` adapter. These tools are not hosted Mem0 API endpoints or additions to the upstream SDK. See the [adapter README](../local-memory/README.md) for installation and configuration.

## Opening retrieval

All MCP hosts receive the same concise initialization instructions (at most 512 characters), without memory text or the full protocol. There is no full-injection compatibility mode. When prior context is needed and absent, call `memory_context` with `{}`; reuse its result unless refreshing or recovering lost context. The tool reads the current repository on every call and returns `{project, count, text}` with the existing curated selection and optional full guidance. It does not perform task-specific retrieval or provide a cross-repository scope.

This requires the agent to call the tool; initialization no longer guarantees delivery of recent memories. The existing Cursor hook remains independent. Startup still checks store readability and returns a short `NOT WORKING` notice on failure; detailed errors stay in the log.

`inject.enabled` and `inject.mcpInstructions` control automatic guidance, not explicit access to `memory_context`. Selection uses `inject.recent`, `maxChars` (memory lines only), `kinds` and `reserve`; `includeProtocol` controls full guidance in the context result. The short MCP instructions do not depend on `includeProtocol`.

Search for one specific question about the current task without `kind`. For repository operations, also search `kind: "convention"` for rules relevant to building, testing, editing or committing. These queries can run in parallel. Search `kind: "decision"` when a design rationale is needed.

`kind` remains a strict filter with no automatic fallback. If results do not answer the question, change one factor and retry: split the question, add an identifier, omit kind or increase topK. Nonempty results do not prove relevance. Queries and memories remain English, with code identifiers preserved verbatim.

## Read tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `memory_context` | No arguments | `{project, count, text}` with fresh, budgeted recent memories and guidance |
| `memory_get` | Required `id`; `scope` is `project` (default) or `all`; `includeExpired` defaults to false | Current memory record, using the same record fields as search/list |
| `memory_history` | Required `id`; optional integer `limit`, default 10, range 1–50 | `{record, truncated, entries}`; text history newest first |
| `memory_search` | Existing query options plus optional boolean `explain`, default false | Existing result wrapper; with explain enabled, records include `scoreDetails` |

`memory_get` accepts a full ID or an unambiguous prefix. Ambiguous prefixes and IDs absent from the requested visible scope return a tool error. Use `includeExpired: true` to inspect an expired record. Explicit `scope: "all"` permits reads across repositories owned by the configured user, but does not grant update or delete permission.

`memory_history` only reads the current repository, including expired records. Deleted records cannot be resolved through this tool, even if their history rows remain in storage. It reports text changes, not a complete audit of metadata. A truncated result means more rows exist; use `node src/cli.mjs history <id>` from the adapter directory for all accessible rows. Existing CLI behavior is unchanged.

For example, send this argument object to `memory_search`:

```json
{"query":"dsdebug _build_argv DS launch flags","topK":3,"explain":true}
```

Search returns full text and metadata. Reuse recent full records from search/list/get/history before edits; use `memory_get` only when the record is missing, incomplete or possibly stale. Do not routinely re-read search hits. Use `memory_history` for text changes. `scoreDetails` exposes semantic, BM25 and entity contributions; it does not certify an exact identifier match or factual correctness, and enabling it does not change ordering.

Inspect the target record before a correction. The update tool reads storage back: check its returned record and use `memory_get` only if incomplete or possibly stale. A direct read confirms stored content; verify factual claims against current evidence. To assess recall quality, optionally use an identifier query and a natural-language query; ordinary writes need no extra searches.

## Writing and interpreting results

English applies to memory text and search queries, not replies to the user. Each write tool includes its own text, category and evidence guidance; discovering `memory_update` does not require first discovering `memory_add`.

Use `context` with `expiresAt` for reusable temporary requirements or scope; omit progress reports and tool logs. Category describes content, while evidence describes its basis: `fact` does not require `verified` evidence.

`memory_add` normally submits one fact subject to deduplication. With `distil: true`, extraction can yield zero or multiple records; if the model is unavailable or fails, the input may be stored verbatim. Read returned IDs to check. An empty write result does not prove an equivalent record exists.

Text-only updates preserve evidence and verifiedAt. Supplying evidence, even its existing value, requires confidenceReason; supplying verified/user_confirmed refreshes the default verification time. Reassess the evidence for the corrected claim rather than blindly resubmitting metadata.

An empty context selection does not mean the repository has no searchable memories. Increasing topK can change the candidate pool and ordering. The non-Latin-query warning only inspects query text; it does not report which signals actually ran.

## Verification

Run `node scripts/test-mcp-reads.mjs` from `local-memory/`. The test copies an existing English embedding cache into a disposable data directory and exercises real MCP calls against mem0. It does not use production memories, an LLM or the reranker. Supply the model cache directory as the first argument if it is not in the default location. Add `--compat` to also run the existing MCP and CLI suites against a second disposable store.
