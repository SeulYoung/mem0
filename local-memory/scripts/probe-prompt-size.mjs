#!/usr/bin/env node
/**
 * Measures what mem0 actually sends to the LLM on an infer add. The transport
 * we can use (and the per-capture token bill) both depend on this, so measure
 * rather than estimate.
 */
import { loadConfig } from "../src/config.mjs";
import { createEmbedder } from "../src/embedder.mjs";
import { PATHS } from "../src/paths.mjs";

const config = loadConfig();
const embedder = createEmbedder(config);
const { Memory } = await import("mem0ai/oss");

const captured = [];
const recorder = {
  model: "recorder",
  async invoke(messages) {
    captured.push(messages);
    // Valid empty extraction so the add finishes cleanly.
    return { content: '{"memory": []}' };
  },
};

const memory = new Memory({
  version: "v1.1",
  embedder: { provider: "langchain", config: { model: embedder } },
  vectorStore: {
    provider: "memory",
    config: { collectionName: "mem0_local", dbPath: PATHS.vectorDb, dimension: config.embedder.dimension },
  },
  llm: { provider: "langchain", config: { model: recorder } },
  historyStore: { provider: "sqlite", config: { historyDbPath: PATHS.historyDb } },
});

await memory.add("测试一下抽取 prompt 有多大，顺便说下我们项目禁止在 Lua 业务代码里用 pcall。", {
  userId: config.userId,
  infer: true,
  metadata: { project: "prompt-size-probe", kind: "note", source: "probe" },
});

for (const messages of captured) {
  console.error(`\n=== LLM call with ${messages.length} messages ===`);
  let total = 0;
  for (const message of messages) {
    const role = typeof message._getType === "function" ? message._getType() : message.role;
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    total += content.length;
    console.error(`  ${String(role).padEnd(8)} ${String(content.length).padStart(7)} chars`);
    // Show where the bulk sits.
    const headings = content.match(/^#{1,3} .+$/gm) ?? [];
    for (const heading of headings.slice(0, 40)) console.error(`      ${heading.slice(0, 90)}`);
  }
  console.error(`  TOTAL    ${String(total).padStart(7)} chars (~${Math.round(total / 3.5)} tokens)`);
}
