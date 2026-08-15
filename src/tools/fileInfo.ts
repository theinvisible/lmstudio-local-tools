import { tool } from "@lmstudio/sdk";
import { lstat, stat } from "node:fs/promises";
import { z } from "zod";
import { resolveSafePath } from "../lib/sandbox";
import { describeError, type ToolDeps } from "./../lib/shared";

export function createFileInfoTool(deps: ToolDeps) {
  return tool({
    name: "file_info",
    description:
      "Get metadata about a file or directory without reading it: size, type, creation and " +
      "modification time, and whether it is a symbolic link. Useful to check whether something " +
      "exists or how big it is before reading it.",
    parameters: {
      path: z.string().describe("Absolute path, or relative to the conversation working directory."),
    },
    implementation: async ({ path }, { status, warn }) => {
      try {
        status(`Inspecting ${path} ...`);
        const resolved = await resolveSafePath(path, deps);

        const info = await stat(resolved);
        // The resolved path is already realpath'd, so compare against the original to spot links.
        const link = await lstat(path).catch(() => null);

        return {
          path: resolved,
          exists: true,
          type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
          size: info.size,
          modified: info.mtime.toISOString(),
          created: info.birthtime.toISOString(),
          isSymlink: link?.isSymbolicLink() ?? false,
          ...(resolved !== path ? { resolvedFrom: path } : {}),
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return { path, exists: false };
        const message = describeError(error);
        warn(`file_info: ${message}`);
        return { path, error: message };
      }
    },
  });
}
