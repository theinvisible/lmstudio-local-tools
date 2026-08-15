import { tool, type Tool } from "@lmstudio/sdk";
import { z } from "zod";
import { getMemoryStore } from "../lib/store";
import { describeError, type ToolDeps } from "./../lib/shared";

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
        const { entry, replaced } = await store.remember(key, content, tags ?? []);
        const total = await store.count();
        status(replaced ? `Updated "${key}"` : `Stored "${key}"`);
        return { key: entry.key, replaced, stored_at: entry.updatedAt, total_memories: total };
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
      "not have in the current conversation. Without a query it returns the most recently updated notes.",
    parameters: {
      query: z.string().optional().describe("Words to search for in the key, content and tags."),
      tags: z.array(z.string()).optional().describe("Only return notes carrying one of these tags."),
      limit: z.number().int().positive().max(50).optional().describe("Maximum notes to return (default 10)."),
    },
    implementation: async ({ query, tags, limit }, { status, warn }) => {
      try {
        status("Recalling ...");
        const entries = await store.recall(query, tags ?? [], limit ?? 10);
        status(`Found ${entries.length} memories`);
        return {
          query: query ?? null,
          count: entries.length,
          memories: entries,
          ...(entries.length === 0 ? { note: "Nothing stored matches. Nothing was remembered about this yet." } : {}),
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
