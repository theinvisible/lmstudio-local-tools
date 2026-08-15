import { tool } from "@lmstudio/sdk";
import { glob } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { resolveSafePath } from "../lib/sandbox";
import { describeError, type ToolDeps } from "./../lib/shared";

/**
 * Enumerates paths matching a glob, then re-validates every hit through the sandbox. The second
 * pass matters: glob walks the tree itself, so without it a symlink could surface a path that
 * resolveSafePath would have refused.
 */
export async function globInSandbox(
  pattern: string,
  root: string,
  limit: number,
  deps: ToolDeps,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;

  for await (const match of glob(pattern, { cwd: root })) {
    if (files.length >= limit) {
      truncated = true;
      break;
    }
    try {
      files.push(await resolveSafePath(join(root, match), deps));
    } catch {
      // Denied by the sandbox (secret name, escaping symlink) — silently skip, it is not a hit.
    }
  }

  return { files, truncated };
}

export function createFindFilesTool(deps: ToolDeps) {
  return tool({
    name: "find_files",
    description:
      "Find files by name pattern, e.g. '**/*.ts' or 'src/**/config.*'. Use this when you know " +
      "roughly what a file is called but not where it lives. Searches only inside the configured " +
      "allowed directories.",
    parameters: {
      pattern: z.string().describe("Glob pattern, e.g. '**/*.log' or 'src/**/*.{ts,tsx}'."),
      root: z.string().optional().describe("Directory to search in (default: the conversation working directory)."),
      max_results: z.number().int().positive().max(1000).optional().describe("Maximum matches to return (default 200)."),
    },
    implementation: async ({ pattern, root, max_results }, { status, warn }) => {
      const limit = max_results ?? 200;
      try {
        const base = await resolveSafePath(root ?? deps.baseDir, deps);
        status(`Searching for ${pattern} in ${base} ...`);

        const { files, truncated } = await globInSandbox(pattern, base, limit, deps);

        status(`Found ${files.length} files`);
        return { pattern, root: base, count: files.length, truncated, files };
      } catch (error) {
        const message = describeError(error);
        warn(`find_files: ${message}`);
        return { pattern, error: message };
      }
    },
  });
}
