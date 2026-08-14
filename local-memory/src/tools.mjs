/**
 * The six MCP tools, as schemas — which is to say: as prompt text. Apart from
 * the injected protocol, this is everything a host tells the agent about the
 * memory layer, and nothing here runs anything.
 *
 * Kept out of `mcp-server.mjs` so `scripts/test-prompts.mjs` can import the
 * wording without starting a server.
 */
import { KINDS, KIND_GUIDE } from "./memory.mjs";
import { ENGLISH_ONLY, KEEP_IDENTIFIERS, MEMORY_LENGTH, SPLIT_NOT_COMPRESS } from "./wording.mjs";

const SCOPE_READ = {
  type: "string",
  enum: ["project", "all"],
  description: 'Search this repository ("project", default) or every repository ("all").',
};

/**
 * The catalog, plus the two overlaps that get judged wrong (measurements filed as
 * `gotcha`, this layer's own choices filed as `fact`) and the two things that are
 * not memories at all: work in flight, which is wrong within the week, and work
 * not yet done, which nothing here removes unless it carries an expiry.
 */
const KIND_DESCRIPTION = [
  'Which category the memory belongs to (default "note"):',
  ...Object.entries(KIND_GUIDE).map(([kind, test]) => `- ${kind}: ${test}`),
  "If it fits both fact and gotcha, ask whether something goes wrong when you do not know it, and whether it goes wrong quietly — a constraint that fails loudly on the first try is a fact, not a gotcha.",
  "If it fits both convention and decision, what you have to follow is a convention; what explains why things look the way they do is a decision.",
  'Never store a progress report: "X is now done" stops being true and reads as news forever. Write the durable fact the work left behind.',
  "Storing something not yet built — a design you worked out, a step you agreed — needs an expiresAt, because nothing else in this store ever removes it.",
].join("\n");

const MEMORY_ID = {
  type: "string",
  description:
    'Memory id from memory_search, memory_list, or the list injected at the start of this session. The shortened eight-character form shown there is enough. Must name a memory belonging to this repository — memories owned by another repository are readable with scope "all" but can only be changed from the repository that owns them.',
};

/**
 * Built from config rather than frozen, because one description quotes a
 * configured default and a description that lies about the default is worse than
 * one that omits it.
 */
export function memoryTools(config) {
  return [
    {
      name: "memory_search",
      description:
        "Search the local memory store for things learned in earlier sessions (user preferences, project conventions, past decisions, gotchas). Call this before answering questions that depend on prior context, and whenever the user refers to something previously discussed.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: `Natural-language description of what you are looking for, in English — memories are stored in English, so translate the user's wording rather than passing it through. ${ENGLISH_ONLY} ${KEEP_IDENTIFIERS}`,
          },
          topK: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: `How many memories to return (default ${config.search.topK}). Raise it when the first answer looks incomplete; the results are ordered, so the extra ones are weaker matches rather than more of the same.`,
          },
          scope: SCOPE_READ,
        },
        required: ["query"],
      },
    },
    {
      name: "memory_add",
      description: `Store one durable fact worth remembering in future sessions: a user preference, a project convention, an architectural decision and its reason, or a non-obvious pitfall. ${MEMORY_LENGTH} ${SPLIT_NOT_COMPRESS} Do not store transient task state, secrets, or anything already obvious from the code.`,
      inputSchema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: `The memory, as one self-contained English statement opening with the topic it is about — English even when the conversation is in another language. ${ENGLISH_ONLY} ${KEEP_IDENTIFIERS}`,
          },
          kind: { type: "string", enum: KINDS, description: KIND_DESCRIPTION },
          distil: {
            type: "boolean",
            description:
              "Default false, which stores your text as written — normally the right choice, since you are already writing one clean fact. Set true only to hand a longer, messy passage to the summarisation model, which will split it into facts and drop anything already stored. Costs about 15 seconds.",
          },
          expiresAt: {
            type: "string",
            description:
              'Date after which this memory is ignored, as "YYYY-MM-DD". Set it when the fact has a known shelf life — a measured duration, a dependency version, a workaround for a bug that will be fixed. Leave it out for anything that should be remembered indefinitely.',
          },
          force: {
            type: "boolean",
            description:
              "Store the memory even though an existing one already says nearly the same thing. Only use this after a rejection told you which memory it collided with and you decided the two really are different facts; the normal response to that rejection is memory_update on the memory named in it.",
          },
        },
        required: ["text"],
      },
    },
    {
      name: "memory_list",
      description:
        "List the most recently stored memories, newest first. Useful for reviewing or cleaning up what was captured.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 50, description: "How many to return (default 10)." },
          scope: SCOPE_READ,
          includeExpired: {
            type: "boolean",
            description:
              "Also list memories whose expiry date has passed. They are hidden everywhere else, so this is the only way to find one and revive it with memory_update.",
          },
        },
      },
    },
    {
      name: "memory_update",
      description:
        "Rewrite a memory that has turned out to be wrong or has drifted out of date, keeping its id and its original date. Prefer this over deleting and adding: memories are never overwritten automatically, so a corrected fact added as a new memory just sits alongside the stale one and both come back in future searches. Also use it to put an expiry date on a fact with a known shelf life — once that date passes the memory stops appearing in searches and in the next session's context.",
      inputSchema: {
        type: "object",
        properties: {
          id: MEMORY_ID,
          // Pointer rather than a second copy of the length rule: both tools are
          // listed together in every session, and pointing is the one form that
          // cannot drift from what it points at.
          text: {
            type: "string",
            description:
              "The corrected memory, written the way memory_add wants it: one self-contained English statement opening with the topic, at the length and level of detail memory_add describes. State the fact as it is now — do not describe the correction.",
          },
          kind: {
            type: "string",
            enum: KINDS,
            description: "Move the memory to a different category, judged by the same tests memory_add lists.",
          },
          expiresAt: {
            type: ["string", "null"],
            description:
              'Date after which this memory is ignored, as "YYYY-MM-DD". Use it for facts with a known shelf life, such as a measured duration or a dependency version. Pass null to remove an expiry that was set earlier.',
          },
        },
        required: ["id"],
      },
    },
    {
      name: "memory_delete",
      description:
        "Delete one memory by id. Use it when a remembered fact should simply be gone; if it is merely wrong or outdated, memory_update keeps the history instead.",
      inputSchema: { type: "object", properties: { id: MEMORY_ID }, required: ["id"] },
    },
    {
      name: "memory_stats",
      description:
        "Report how many memories are stored, split by repository and category, plus where the data lives on disk.",
      inputSchema: { type: "object", properties: {} },
    },
  ];
}
