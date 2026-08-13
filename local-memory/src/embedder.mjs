import { PATHS, ensureDirs, log } from "./paths.mjs";

/**
 * Embedders are exposed as duck-typed LangChain `Embeddings` objects
 * (`embedQuery` + `embedDocuments`). mem0's `langchain` embedder provider only
 * checks for those two methods, which gives us a stable extension point without
 * patching anything inside mem0 itself.
 */

function normalize(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function createFastEmbedEmbedder(embedderConfig) {
  const modelName = embedderConfig.model || "fast-bge-small-zh-v1.5";
  let modelPromise;

  async function getModel() {
    if (!modelPromise) {
      modelPromise = (async () => {
        ensureDirs();
        const { FlagEmbedding } = await import("fastembed");
        log("embedder", `loading fastembed model ${modelName} from ${PATHS.modelCache}`);
        return FlagEmbedding.init({
          model: modelName,
          cacheDir: PATHS.modelCache,
          // Progress bars would corrupt the MCP stdio channel.
          showDownloadProgress: false,
        });
      })().catch((error) => {
        modelPromise = undefined;
        throw error;
      });
    }
    return modelPromise;
  }

  async function embedAll(texts) {
    const model = await getModel();
    const out = [];
    for await (const batch of model.embed(texts.map(normalize))) {
      out.push(...batch.map((vector) => Array.from(vector)));
    }
    if (out.length !== texts.length) {
      throw new Error(`fastembed returned ${out.length} vectors for ${texts.length} inputs`);
    }
    return out;
  }

  return {
    async embedQuery(text) {
      const [vector] = await embedAll([text]);
      return vector;
    },
    embedDocuments: embedAll,
    info: { provider: "fastembed", model: modelName, local: true, cacheDir: PATHS.modelCache },
  };
}

function createOpenAICompatibleEmbedder(embedderConfig) {
  const baseURL = (embedderConfig.baseURL || "").replace(/\/+$/, "");
  if (!baseURL) {
    throw new Error(
      'embedder.provider is "openai" but embedder.baseURL is empty. Set it to an OpenAI-compatible endpoint, e.g. http://localhost:11434/v1',
    );
  }
  const model = embedderConfig.model || "text-embedding-3-small";
  const apiKey = embedderConfig.apiKey || process.env.MEM0_LOCAL_EMBED_API_KEY || "not-needed";

  async function embedAll(texts) {
    const response = await fetch(`${baseURL}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: texts.map(normalize) }),
    });
    if (!response.ok) {
      throw new Error(`Embedding request failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
    }
    const payload = await response.json();
    return (payload.data ?? []).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((item) => item.embedding);
  }

  return {
    async embedQuery(text) {
      const [vector] = await embedAll([text]);
      return vector;
    },
    embedDocuments: embedAll,
    info: { provider: "openai-compatible", model, local: false, baseURL },
  };
}

export function createEmbedder(config) {
  const embedderConfig = config.embedder ?? {};
  switch (embedderConfig.provider) {
    case "openai":
    case "openai-compatible":
      return createOpenAICompatibleEmbedder(embedderConfig);
    case "fastembed":
    case undefined:
      return createFastEmbedEmbedder(embedderConfig);
    default:
      throw new Error(`Unknown embedder.provider "${embedderConfig.provider}". Use "fastembed" or "openai".`);
  }
}
