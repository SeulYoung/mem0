#!/usr/bin/env node
/**
 * Measures retrieval quality on a Chinese corpus that looks like this project's
 * real memories, so the choice of embedding model and language is made on
 * numbers instead of intuition.
 *
 * Configurations compared:
 *   zh-small        current setup: bge-small-zh-v1.5, Chinese memories
 *   zh-small+instr  same, plus bge's Chinese query instruction on the query
 *   zh-e5           multilingual-e5-large, Chinese memories, query:/passage:
 *   en-small        English memories + English queries (translate on write)
 *   en-e5           same, on e5
 *   cross-e5        Chinese memories + English queries (translate on read only)
 *
 * Reported per configuration:
 *   top1     share of queries whose best hit is the right memory
 *   MRR      mean reciprocal rank of the right memory
 *   margin   mean (score of right memory − best score among wrong ones).
 *            This is the number that matters: absolute similarity can sit at
 *            0.5 for everything and still rank perfectly, as long as the
 *            margin is positive and stable.
 *
 * Usage: node scripts/bench-embedding.mjs [config ...]
 */
import { PATHS, ensureDirs } from "../src/paths.mjs";

// A memory and its English rendering. `tag` is the ground-truth key.
const DOCS = [
  {
    tag: "wal",
    zh: "给 mem0 的 SQLite 文件设置 journal_mode = WAL 必须在 mem0 打开该文件之前完成。切换 journal mode 需要排他锁，晚了就是在跟它抢锁，Windows 上可能直接卡住。",
    en: "journal_mode = WAL must be set on mem0's SQLite files before mem0 opens them; switching journal mode needs an exclusive lock, so doing it late means fighting mem0 for the lock and can hang on Windows.",
  },
  {
    tag: "isolation",
    zh: "跨仓库记忆隔离：记忆本体靠 metadata 的 project 过滤，抽取上下文则靠每个仓库一个历史库文件。因为 mem0 的 historyStore.getLastMessages 只按 user_id 作用域、拿不到 metadata，否则别的仓库的 prompt 会串进本仓库的抽取上下文。",
    en: "Cross-repository isolation: memories are scoped by the project metadata filter, and extraction context by one history database per repository, because mem0's historyStore.getLastMessages is scoped only by user_id and cannot see metadata, so another repository's prompts would leak into this repository's extraction context.",
  },
  {
    tag: "cursor-cli",
    zh: "记忆的总结模型走 Cursor CLI（cursor-agent --print --output-format json），而不是 OpenAI 兼容端点——Cursor 的 API key 并没有可用的 chat completions 接口。默认模型是 claude-sonnet-5-low。",
    en: "The summarisation model runs through the Cursor CLI (cursor-agent --print --output-format json) rather than an OpenAI-compatible endpoint, because Cursor's API key has no usable chat completions endpoint; the default model is claude-sonnet-5-low.",
  },
  {
    tag: "prompt-size",
    zh: "mem0 的事实抽取 prompt 约 34k 字符，超过 Windows 命令行长度上限，所以长 prompt 必须写进临时文件、让 cursor-agent 去读那个文件，不能直接作为命令行参数传。",
    en: "mem0's fact-extraction prompt is around 34k characters, past the Windows command-line limit, so a long prompt has to be written to a temporary file for cursor-agent to read instead of being passed as an argument.",
  },
  {
    tag: "recursion",
    zh: "用于总结的 cursor-agent 会继承用户的 Cursor 配置，可能反过来触发 MCP 与 hooks 造成递归和配额消耗。防线有两条：给子进程设环境变量，以及判断当前项目根是否落在临时工作区里。",
    en: "The cursor-agent used for summarisation inherits the user's Cursor configuration and can re-trigger the MCP server and hooks, causing recursion and quota burn; the two guards are an environment marker on the child process and checking whether the project root sits inside the scratch workspace.",
  },
  {
    tag: "filters",
    zh: "给 mem0 传项目过滤必须用数组简写。写成带 in 操作符的对象会被 mem0 的高级操作符逻辑判定，进而把所有对象取值的键删掉重写；数组被它明确排除在外，能原样透传到存储层。",
    en: "Project filters must be passed to mem0 as an array shorthand; writing them as an object with an in operator trips mem0's advanced-operator handling, which deletes and rewrites every object-valued key, whereas arrays are explicitly excluded and pass through to the store untouched.",
  },
  {
    tag: "signals",
    zh: "mem0 的检索是语义、BM25 关键词、实体加权三路并行打分后融合，但它的词形还原只取 ASCII，实体抽取只认引号内容、大写专名和代码标识符。所以纯中文查询只有语义信号，含文件名或命令名的查询三路都能命中。",
    en: "mem0 fuses three retrieval signals in parallel — semantic, BM25 keyword and entity boost — but its lemmatiser keeps only ASCII and its entity extractor recognises quoted text, capitalised proper nouns and code identifiers, so a Chinese-only query gets the semantic signal alone while a query naming a file or command hits all three.",
  },
  {
    tag: "entity-path",
    zh: "mem0 的实体抽取与链接只发生在开启抽取的写入路径，原文写入路径不写实体库。所以原文存储的记忆只有语义和 BM25 两路信号，需要实体加权就得开抽取。",
    en: "mem0 extracts and links entities only on the inference write path; the verbatim write path never touches the entity store, so verbatim memories carry just the semantic and BM25 signals and entity boosting requires turning inference on.",
  },
  {
    tag: "dedupe",
    zh: "记忆判重用输入原文的 md5 哈希，而不是比对存储文本：开启抽取后存下来的文本和输入已经不一样，比文本会让重发的同一条 prompt 再白花一次模型调用。",
    en: "Deduplication keys on an md5 hash of the raw input rather than comparing stored text, because with inference on the stored text no longer resembles the input, so comparing text would let a resubmitted prompt pay for another model call.",
  },
  {
    tag: "schema",
    zh: "mem0 用严格 schema 校验模型回复：数组里每条要求字符串 id 和 text，可选归属字段和链接 id 列表，校验失败才退到宽松解析。",
    en: "mem0 validates the model's reply against a strict schema where every item needs a string id and text, with optional attribution and linked id fields, and only falls back to lenient parsing when validation fails.",
  },
  {
    tag: "stdout",
    zh: "MCP 用 stdout 传 JSON-RPC，所以本层把 console 的日志重定向到 stderr。mem0 自身从不直接写 stdout，且它的各类提示在关闭遥测后直接返回。",
    en: "MCP carries JSON-RPC over stdout, so this layer redirects console logging to stderr; mem0 itself never writes to stdout directly and all of its notices return immediately once telemetry is off.",
  },
  {
    tag: "cli-args",
    zh: "命令行参数解析必须显式声明不带值的开关，否则 add 命令会把 kind 的值当成正文存进记忆，而 search 会把查询词当成开关的值吞掉。",
    en: "The command-line parser must declare which flags take no value, otherwise the add command stores the kind's value as part of the memory body and search swallows the query as if it were a flag's value.",
  },
];

// Questions phrased the way they would actually be asked, not as keyword lists.
const QUERIES = [
  { tag: "wal", zh: "WAL 应该在什么时候设置", en: "when should WAL be enabled" },
  { tag: "isolation", zh: "别的仓库的记忆会不会串进来", en: "can memories from another repository leak in" },
  { tag: "cursor-cli", zh: "为什么总结模型不直接用 OpenAI 接口", en: "why not use the OpenAI API for summarisation" },
  { tag: "prompt-size", zh: "抽取的提示词太长了怎么传给模型", en: "how is a very long extraction prompt passed to the model" },
  { tag: "recursion", zh: "怎么防止总结的时候自己套自己", en: "how is recursion during summarisation prevented" },
  { tag: "filters", zh: "过滤条件该怎么写才不会被改掉", en: "how should filters be written so they are not rewritten" },
  { tag: "signals", zh: "中文查询的关键词匹配有效吗", en: "does keyword matching work for Chinese queries" },
  { tag: "entity-path", zh: "什么情况下才会有实体加权", en: "when does entity boosting actually apply" },
  { tag: "dedupe", zh: "同一句话重复记录会不会浪费调用", en: "does repeating the same input waste a model call" },
  { tag: "schema", zh: "模型回复的格式有什么要求", en: "what format is required of the model's reply" },
  { tag: "stdout", zh: "日志会不会破坏协议通道", en: "can logging corrupt the protocol channel" },
  { tag: "cli-args", zh: "为什么记忆正文末尾多了个词", en: "why did an extra word end up in the memory body" },
];

const BGE_ZH_INSTRUCTION = "为这个句子生成表示以用于检索相关文章：";

const CONFIGS = {
  "zh-small": { model: "fast-bge-small-zh-v1.5", lang: "zh", doc: (t) => t, query: (t) => t },
  "zh-small+instr": {
    model: "fast-bge-small-zh-v1.5",
    lang: "zh",
    doc: (t) => t,
    query: (t) => `${BGE_ZH_INSTRUCTION}${t}`,
  },
  "zh-e5": {
    model: "fast-multilingual-e5-large",
    lang: "zh",
    doc: (t) => `passage: ${t}`,
    query: (t) => `query: ${t}`,
  },
  // English memories read by the Chinese model — the naive version of "just
  // store English", kept to show why the model has to change too.
  "en-on-zh-model": { model: "fast-bge-small-zh-v1.5", lang: "en", doc: (t) => t, query: (t) => t },
  // The fair version: English memories on an English model.
  "en-bge-en": { model: "fast-bge-small-en-v1.5", lang: "en", doc: (t) => t, query: (t) => t },
  "en-bge-en+instr": {
    model: "fast-bge-small-en-v1.5",
    lang: "en",
    doc: (t) => t,
    query: (t) => `Represent this sentence for searching relevant passages: ${t}`,
  },
  "en-e5": {
    model: "fast-multilingual-e5-large",
    lang: "en",
    doc: (t) => `passage: ${t}`,
    query: (t) => `query: ${t}`,
  },
  // Bilingual storage: the Chinese fact with an English rendering appended, so
  // a query in either language has something to match.
  "bi-zh-query": {
    model: "fast-bge-small-zh-v1.5",
    lang: "zh",
    docLang: "bi",
    queryLang: "zh",
    doc: (t) => t,
    query: (t) => t,
  },
  "bi-en-query": {
    model: "fast-bge-small-zh-v1.5",
    lang: "en",
    docLang: "bi",
    queryLang: "en",
    doc: (t) => t,
    query: (t) => t,
  },
  "cross-e5": {
    model: "fast-multilingual-e5-large",
    lang: "zh",
    docLang: "zh",
    queryLang: "en",
    doc: (t) => `passage: ${t}`,
    query: (t) => `query: ${t}`,
  },
};

const models = new Map();
async function embedWith(modelName, texts) {
  if (!models.has(modelName)) {
    ensureDirs();
    const { FlagEmbedding } = await import("fastembed");
    process.stderr.write(`loading ${modelName} (first run downloads it)\n`);
    models.set(
      modelName,
      await FlagEmbedding.init({ model: modelName, cacheDir: PATHS.modelCache, showDownloadProgress: false }),
    );
  }
  const out = [];
  for await (const batch of models.get(modelName).embed(texts)) out.push(...batch.map((v) => Array.from(v)));
  return out;
}

const cosine = (a, b) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

async function run(name) {
  const config = CONFIGS[name];
  const docLang = config.docLang ?? config.lang;
  const queryLang = config.queryLang ?? config.lang;

  const textOf = (entry, lang) => (lang === "bi" ? `${entry.zh}\n${entry.en}` : entry[lang]);
  const docVectors = await embedWith(config.model, DOCS.map((doc) => config.doc(textOf(doc, docLang))));
  const queryVectors = await embedWith(config.model, QUERIES.map((query) => config.query(textOf(query, queryLang))));

  let top1 = 0;
  let reciprocalRanks = 0;
  let margins = 0;
  const misses = [];

  QUERIES.forEach((query, qi) => {
    const ranked = DOCS.map((doc, di) => ({ tag: doc.tag, score: cosine(queryVectors[qi], docVectors[di]) })).sort(
      (a, b) => b.score - a.score,
    );
    const rank = ranked.findIndex((entry) => entry.tag === query.tag) + 1;
    const right = ranked.find((entry) => entry.tag === query.tag).score;
    const bestWrong = ranked.find((entry) => entry.tag !== query.tag).score;
    if (rank === 1) top1 += 1;
    else misses.push(`${query.tag}→${ranked[0].tag}@${rank}`);
    reciprocalRanks += 1 / rank;
    margins += right - bestWrong;
  });

  const n = QUERIES.length;
  return {
    name,
    dims: docVectors[0].length,
    top1: top1 / n,
    mrr: reciprocalRanks / n,
    margin: margins / n,
    misses,
  };
}

const requested = process.argv.slice(2).filter((token) => CONFIGS[token]);
const wanted = requested.length > 0 ? requested : Object.keys(CONFIGS);

process.stdout.write(`corpus: ${DOCS.length} memories, ${QUERIES.length} queries\n\n`);
process.stdout.write("config           dims  top1   MRR    margin\n");
const rows = [];
for (const name of wanted) {
  const row = await run(name);
  rows.push(row);
  process.stdout.write(
    `${row.name.padEnd(16)} ${String(row.dims).padStart(4)}  ${(row.top1 * 100).toFixed(0).padStart(3)}%  ` +
      `${row.mrr.toFixed(3)}  ${row.margin >= 0 ? "+" : ""}${row.margin.toFixed(3)}\n`,
  );
}
process.stdout.write("\nmisses (query→wrong top hit @rank of the right one):\n");
for (const row of rows) process.stdout.write(`  ${row.name.padEnd(16)} ${row.misses.join("  ") || "(none)"}\n`);
