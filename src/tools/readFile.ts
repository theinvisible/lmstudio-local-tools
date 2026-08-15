import { tool } from "@lmstudio/sdk";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { decodeText, looksBinary, resolveReadableFile } from "../lib/sandbox";
import { clamp, describeError, type ToolDeps } from "./../lib/shared";

export function createReadFileTool(deps: ToolDeps) {
  return tool({
    name: "read_file",
    description:
      "Read a text file from disk — source code, configuration, logs, notes. Read it in parts with " +
      "offset_lines/max_lines, or jump straight to the end with last_lines, which is what you want " +
      "for log files. Only paths inside the configured directories can be read.",
    parameters: {
      path: z.string().describe("Absolute path, or relative to the conversation working directory."),
      offset_lines: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("1-based line to start at (default 1). Use this to page through a long file."),
      max_lines: z.number().int().positive().optional().describe("How many lines to return. Capped by the plugin settings."),
      last_lines: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Return the LAST N lines instead of reading from the start — the usual way to look at a log. " +
            "Cannot be combined with offset_lines.",
        ),
      show_line_numbers: z
        .boolean()
        .optional()
        .describe("Prefix every line with its real line number, so you can jump back to it later."),
      encoding: z
        .enum(["utf-8", "utf-16le", "latin1", "ascii"])
        .optional()
        .describe("Text encoding (default utf-8). Try latin1 if the text comes back garbled."),
    },
    implementation: async ({ path, offset_lines, max_lines, last_lines, show_line_numbers, encoding }, { status, warn }) => {
      if (last_lines !== undefined && offset_lines !== undefined) {
        return {
          path,
          error: "Give either last_lines or offset_lines, not both — they describe opposite ends of the file.",
        };
      }
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
        const limit = clamp(last_lines ?? max_lines, deps.defaults.maxLines);
        const start =
          last_lines !== undefined ? Math.max(0, lines.length - limit) : (offset_lines ?? 1) - 1;
        const slice = lines.slice(start, start + limit);

        const content =
          show_line_numbers === true
            ? slice.map((line, index) => `${start + index + 1}\t${line}`).join("\n")
            : slice.join("\n");

        status(`Read ${slice.length} of ${lines.length} lines`);
        return {
          path: file.path,
          size: file.size,
          total_lines: lines.length,
          first_line: start + 1,
          returned_lines: slice.length,
          // With last_lines the tail is complete by definition; only the head above it is missing.
          truncated: start > 0 || start + slice.length < lines.length,
          content,
        };
      } catch (error) {
        const message = describeError(error);
        warn(`read_file: ${message}`);
        return { path, error: message };
      }
    },
  });
}
