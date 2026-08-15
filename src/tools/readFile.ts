import { tool } from "@lmstudio/sdk";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { decodeText, looksBinary, resolveReadableFile } from "../lib/sandbox";
import { clamp, describeError, type ToolDeps } from "./../lib/shared";

export function createReadFileTool(deps: ToolDeps) {
  return tool({
    name: "read_file",
    description:
      "Read a text file from disk — source code, configuration, logs, notes. Returns the content " +
      "with line numbers available via offset_lines/max_lines, so a long file can be read in parts " +
      "instead of all at once. Only paths inside the configured directories can be read.",
    parameters: {
      path: z.string().describe("Absolute path, or relative to the conversation working directory."),
      offset_lines: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("1-based line to start at (default 1). Use this to page through a long file."),
      max_lines: z.number().int().positive().optional().describe("How many lines to return. Capped by the plugin settings."),
      encoding: z
        .enum(["utf-8", "utf-16le", "latin1", "ascii"])
        .optional()
        .describe("Text encoding (default utf-8). Try latin1 if the text comes back garbled."),
    },
    implementation: async ({ path, offset_lines, max_lines, encoding }, { status, warn }) => {
      try {
        status(`Reading ${path} ...`);
        const file = await resolveReadableFile(path, deps);
        const buffer = await readFile(file.path);

        if (looksBinary(buffer)) {
          return {
            path: file.path,
            error: `"${file.path}" is a binary file (${file.size} bytes) — not returned as text.`,
          };
        }

        const text = decodeText(buffer, encoding ?? "utf-8");
        const lines = text.split(/\r?\n/);
        const start = (offset_lines ?? 1) - 1;
        const limit = clamp(max_lines, deps.defaults.maxLines);
        const slice = lines.slice(start, start + limit);

        status(`Read ${slice.length} of ${lines.length} lines`);
        return {
          path: file.path,
          size: file.size,
          total_lines: lines.length,
          first_line: start + 1,
          returned_lines: slice.length,
          truncated: start + slice.length < lines.length,
          content: slice.join("\n"),
        };
      } catch (error) {
        const message = describeError(error);
        warn(`read_file: ${message}`);
        return { path, error: message };
      }
    },
  });
}
