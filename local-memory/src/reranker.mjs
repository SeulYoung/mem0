import path from "node:path";

import { PATHS, ensureDirs, log } from "./paths.mjs";

/**
 * mem0 owns the reranking: it builds the cross-encoder from the `reranker`
 * section of its config and applies it inside `search()` when asked. All that is
 * left for us is to say which provider, and to put the model file somewhere
 * sensible.
 */
const CROSS_ENCODERS = ["sentence_transformer", "huggingface"];

/**
 * Why the configured reranker cannot be used, or null when it can.
 *
 * mem0 offers three providers beyond these two, and every one of them breaks a
 * promise this layer makes, so they are refused here rather than handed to mem0
 * to build. Refused, not fatal: reranking is an improvement to an ordering, and
 * losing the whole memory layer over a mistyped provider would be wildly out of
 * proportion. `cli doctor` reports this, which is where it belongs.
 */
export function rerankerProblem(config) {
  const provider = config?.reranker?.provider || "sentence_transformer";
  if (CROSS_ENCODERS.includes(provider)) return null;
  return `reranker.provider "${provider}" is not one of the local cross-encoders (${CROSS_ENCODERS.join(", ")}), so search is running without reranking. mem0's "cohere" and "zero_entropy" are HTTP APIs that would send your memory text off this machine, and "llm_reranker" spends one model call per memory.`;
}

export function rerankerConfig(config) {
  const reranker = config?.reranker ?? {};
  if (!reranker.enabled) return null;
  const problem = rerankerProblem(config);
  if (problem) {
    log("reranker", problem);
    return null;
  }
  return {
    provider: reranker.provider || "sentence_transformer",
    // Everything else is mem0's default, including the model that goes with the
    // provider and the sigmoid that maps logits into 0..1.
    config: reranker.model ? { model: reranker.model } : {},
  };
}

let prepared;

/**
 * transformers.js keeps downloaded models in a folder *inside its own package*,
 * which the next `npm install` throws away. Point it at the data directory
 * instead, next to the embedding model, so the download survives.
 *
 * Mutating the library's `env` is how it is configured; mem0 reaches the same
 * module instance when it lazily imports the library on the first rerank, so
 * doing this first is enough.
 */
async function prepare() {
  ensureDirs();
  const { env } = await import("@huggingface/transformers");
  // The trailing separator matters: the library joins paths by concatenation.
  env.cacheDir = `${PATHS.rerankerCache}${path.sep}`;
  log("reranker", `model cache ${env.cacheDir}`);
}

/**
 * True when a rerank can actually be attempted. The cross-encoder library is a
 * heavyweight optional dependency (it brings its own ONNX runtime), so treat it
 * as absent-until-proven: no library means plain search, not a failed search.
 */
export async function rerankerReady() {
  if (!prepared) {
    prepared = prepare().then(
      () => true,
      (error) => {
        log("reranker", `unavailable, searching without it: ${error.message}`);
        return false;
      },
    );
  }
  return prepared;
}
