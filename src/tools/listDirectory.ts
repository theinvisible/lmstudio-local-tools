import { tool } from "@lmstudio/sdk";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import { isDeniedName, NOISY_DIRECTORIES, resolveSafePath } from "../lib/sandbox";
import { describeError, type ToolDeps } from "./../lib/shared";

interface Entry {
  name: string;
  type: "file" | "directory" | "other";
  size?: number;
  modified?: string;
}

export function createListDirectoryTool(deps: ToolDeps) {
  return tool({
    name: "list_directory",
    description:
      "List the contents of a directory: names, whether they are files or directories, sizes and " +
      "modification times. Use this to orient yourself before reading files. Only directories " +
      "inside the configured allowed paths can be listed.",
    parameters: {
      path: z.string().describe("Absolute path, or relative to the conversation working directory."),
      recursive: z
        .boolean()
        .optional()
        .describe("Descend into subdirectories (default false). node_modules, .git, dist and similar are skipped."),
      max_entries: z.number().int().positive().max(2000).optional().describe("Maximum entries to return (default 200)."),
      include_hidden: z.boolean().optional().describe("Include dot-files (default false)."),
    },
    implementation: async ({ path, recursive, max_entries, include_hidden }, { status, warn }) => {
      const limit = max_entries ?? 200;
      try {
        status(`Listing ${path} ...`);
        const root = await resolveSafePath(path, deps);

        const entries: Entry[] = [];
        let truncated = false;

        const walk = async (directory: string, depth: number): Promise<void> => {
          if (entries.length >= limit) {
            truncated = true;
            return;
          }
          const found = await readdir(directory, { withFileTypes: true });

          for (const item of found) {
            if (entries.length >= limit) {
              truncated = true;
              return;
            }
            if (include_hidden !== true && item.name.startsWith(".")) continue;
            if (isDeniedName(item.name, deps.policy.deniedPatterns)) continue;

            const full = join(directory, item.name);
            const type = item.isDirectory() ? "directory" : item.isFile() ? "file" : "other";
            const entry: Entry = { name: depth === 0 ? item.name : relative(root, full), type };

            if (type === "file") {
              try {
                const info = await stat(full);
                entry.size = info.size;
                entry.modified = info.mtime.toISOString();
              } catch {
                // A file we cannot stat is still worth listing by name.
              }
            }
            entries.push(entry);

            if (recursive === true && type === "directory" && !NOISY_DIRECTORIES.has(item.name.toLowerCase())) {
              await walk(full, depth + 1);
            }
          }
        };

        await walk(root, 0);

        status(`Found ${entries.length} entries`);
        return { path: root, count: entries.length, truncated, entries };
      } catch (error) {
        const message = describeError(error);
        warn(`list_directory: ${message}`);
        return { path, error: message };
      }
    },
  });
}
