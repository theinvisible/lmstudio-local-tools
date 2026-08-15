import { tool, type Tool } from "@lmstudio/sdk";
import { z } from "zod";
import { cosineSimilarity, embed, lastEmbeddingFailure } from "../lib/embeddings";
import { getMemoryStore, MemoryStore, type MemoryEntry } from "../lib/store";
import { describeError, type ToolDeps } from "./../lib/shared";

/** How many stale/missing vectors one recall may compute before giving up and ranking with what it has. */
const MAX_BACKFILL_PER_RECALL = 50;
/** Below this cosine similarity an entry is noise rather than a match. */
const MIN_SIMILARITY = 0.25;

export function createMemoryTools(deps: ToolDeps): Tool[] {
  const store = getMemoryStore(deps.memoryFile, deps.maxMemories);

  const rememberTool = tool({
    name: "remember",
    description:
      "Store a note that survives after this conversation ends, so it is available in later chats " +
      "too. Use it for durable facts the user tells you — preferences, project details, decisions — " +
      "not for things that only matter right now. Storing the same key again replaces the note.",
    parameters: {
      key: z.string().min(1).describe("Short identifier, e.g. 'preferred-editor' or 'project-acme-db-host'."),
      content: z.string().min(1).describe("What to remember, written so it still makes sense weeks later."),
      tags: z.array(z.string()).optional().describe("Optional labels for grouping, e.g. ['work', 'acme']."),
    },
    implementation: async ({ key, content, tags }, { status, warn }) => {
      try {
        status(`Remembering "${key}" ...`);
        const tagList = tags ?? [];

        // Embedding failure is not a reason to lose the note — store it either way.
        let vector: { embedding: number[]; embeddingModel: string } | undefined;
        if (deps.enableSemanticRecall) {
          const embedded = await embed([MemoryStore.embedText({ key, content, tags: tagList })], deps.embeddingModel);
          const first = embedded?.vectors[0];
          if (embedded !== null && first !== undefined) {
            vector = { embedding: first, embeddingModel: embedded.model };
          }
        }

        const { entry, replaced } = await store.remember(key, content, tagList, vector);
        const total = await store.count();
        status(replaced ? `Updated "${key}"` : `Stored "${key}"`);
        return {
          key: entry.key,
          replaced,
          stored_at: entry.updatedAt,
          total_memories: total,
          semantic_index: vector !== undefined,
        };
      } catch (error) {
        const message = describeError(error);
        warn(`remember: ${message}`);
        return { key, error: message };
      }
    },
  });

  const recallTool = tool({
    name: "recall",
    description:
      "Look up notes stored earlier with remember, from this or any previous conversation. Call it " +
      "when the user refers to something you were told before, or when you need background you do " +
      "not have in the current conversation. Matches by meaning, not just by wording, so 'which " +
      "editor does he use' finds a note about CLion. Without a query it returns the most recent notes.",
    parameters: {
      query: z.string().optional().describe("What you are looking for, in plain words."),
      tags: z.array(z.string()).optional().describe("Only return notes carrying one of these tags."),
      limit: z.number().int().positive().max(50).optional().describe("Maximum notes to return (default 10)."),
    },
    implementation: async ({ query, tags, limit }, { status, warn }) => {
      const wanted = limit ?? 10;
      const tagList = tags ?? [];

      const keywordFallback = async (note: string) => {
        const entries = await store.recall(query, tagList, wanted);
        return {
          query: query ?? null,
          count: entries.length,
          search: "keyword" as const,
          note,
          memories: entries.map(stripVector),
        };
      };

      try {
        status("Recalling ...");

        if (!deps.enableSemanticRecall || query === undefined || query.trim() === "") {
          const entries = await store.recall(query, tagList, wanted);
          status(`Found ${entries.length} memories`);
          return {
            query: query ?? null,
            count: entries.length,
            search: "keyword" as const,
            memories: entries.map(stripVector),
            ...(entries.length === 0 ? { note: "Nothing stored matches." } : {}),
          };
        }

        const queryVector = await embed([query], deps.embeddingModel);
        const queryEmbedding = queryVector?.vectors[0];
        if (queryVector === null || queryEmbedding === undefined) {
          return keywordFallback(
            `Semantic search unavailable (${lastEmbeddingFailure() ?? "no embedding model"}), used keyword matching instead. ` +
              "Load an embedding model in LM Studio for meaning-based recall.",
          );
        }

        const all = await store.all();
        const candidates =
          tagList.length === 0
            ? all
            : all.filter(entry => tagList.some(tag => entry.tags.some(t => t.toLowerCase() === tag.toLowerCase())));

        // Notes written before semantic search existed, or indexed by a different model, get their
        // vectors now — capped, so the first recall after switching models does not stall.
        const stale = candidates.filter(
          entry => entry.embedding === undefined || entry.embeddingModel !== queryVector.model,
        );
        if (stale.length > 0) {
          const batch = stale.slice(0, MAX_BACKFILL_PER_RECALL);
          status(`Indexing ${batch.length} older notes ...`);
          const embedded = await embed(batch.map(entry => MemoryStore.embedText(entry)), deps.embeddingModel);
          if (embedded !== null) {
            const updates = new Map<string, { embedding: number[]; embeddingModel: string }>();
            batch.forEach((entry, index) => {
              const vector = embedded.vectors[index];
              if (vector === undefined) return;
              entry.embedding = vector;
              entry.embeddingModel = embedded.model;
              updates.set(entry.key, { embedding: vector, embeddingModel: embedded.model });
            });
            await store.attachEmbeddings(updates);
          }
        }

        const needle = query.toLowerCase();
        const scored = candidates
          .filter(entry => entry.embedding !== undefined)
          .map(entry => ({
            entry,
            similarity: cosineSimilarity(queryEmbedding, entry.embedding as number[]),
            exactKey: entry.key.toLowerCase() === needle,
          }))
          .filter(item => item.exactKey || item.similarity >= MIN_SIMILARITY)
          .sort((a, b) => Number(b.exactKey) - Number(a.exactKey) || b.similarity - a.similarity)
          .slice(0, wanted);

        if (scored.length === 0) {
          return keywordFallback("Nothing was semantically close enough; fell back to keyword matching.");
        }

        status(`Found ${scored.length} memories`);
        return {
          query,
          count: scored.length,
          search: "semantic" as const,
          model: queryVector.model,
          memories: scored.map(item => ({ ...stripVector(item.entry), similarity: Number(item.similarity.toFixed(3)) })),
        };
      } catch (error) {
        const message = describeError(error);
        warn(`recall: ${message}`);
        return { error: message };
      }
    },
  });

  const forgetTool = tool({
    name: "forget",
    description:
      "Delete a stored note by its key. Use this when the user asks you to forget something or when " +
      "a remembered fact has become wrong.",
    parameters: {
      key: z.string().min(1).describe("The key of the note to delete."),
    },
    implementation: async ({ key }, { status, warn }) => {
      try {
        const removed = await store.forget(key);
        status(removed ? `Forgot "${key}"` : `No memory named "${key}"`);
        return {
          key,
          removed,
          ...(removed ? {} : { note: "No note with that key existed — use recall to see what is stored." }),
        };
      } catch (error) {
        const message = describeError(error);
        warn(`forget: ${message}`);
        return { key, error: message };
      }
    },
  });

  return [rememberTool, recallTool, forgetTool];
}

/** Vectors are hundreds of numbers — useful on disk, pure noise in a tool result. */
function stripVector(entry: MemoryEntry): Omit<MemoryEntry, "embedding" | "embeddingModel"> {
  const { embedding, embeddingModel, ...rest } = entry;
  void embedding;
  void embeddingModel;
  return rest;
}
