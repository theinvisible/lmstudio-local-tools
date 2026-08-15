import { tool } from "@lmstudio/sdk";
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { decodeText, looksBinary, resolveSafePath } from "../lib/sandbox";
import { clamp, describeError, mapWithConcurrency, type ToolDeps } from "./../lib/shared";
import { globInSandbox } from "./findFiles";

interface Hit {
  file: string;
  line: number;
  text: string;
  context_before?: string[];
  context_after?: string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createSearchInFilesTool(deps: ToolDeps) {
  return tool({
    name: "search_in_files",
    description:
      "Search the contents of many files at once and return the matching lines with their file, " +
      "line number and surrounding context — grep for the model. This is usually the fastest way " +
      "to answer 'where is X defined / where does this error come from' without reading whole files.",
    parameters: {
      pattern: z.string().describe("Text to look for, or a regular expression when regex is true."),
      root: z.string().optional().describe("Directory to search in (default: the conversation working directory)."),
      glob: z
        .string()
        .optional()
        .describe("Which files to look at, e.g. '**/*.ts' or '**/*.log' (default '**/*')."),
      context_lines: z.number().int().min(0).max(20).optional().describe("Lines of context around each hit."),
      max_matches: z.number().int().positive().optional().describe("Maximum hits to return. Capped by the plugin settings."),
      case_sensitive: z.boolean().optional().describe("Match case exactly (default false)."),
      regex: z.boolean().optional().describe("Treat the pattern as a regular expression (default false)."),
      max_files: z.number().int().positive().max(5000).optional().describe("Maximum files to scan (default 1000)."),
    },
    implementation: async (
      { pattern, root, glob, context_lines, max_matches, case_sensitive, regex, max_files },
      { status, warn, signal },
    ) => {
      const maxMatches = clamp(max_matches, deps.defaults.maxMatches);
      const contextLines = context_lines ?? deps.defaults.contextLines;
      const maxFiles = max_files ?? 1000;

      let matcher: RegExp;
      try {
        matcher = new RegExp(regex === true ? pattern : escapeRegExp(pattern), case_sensitive === true ? "" : "i");
      } catch (error) {
        return { pattern, error: `Invalid regular expression: ${(error as Error).message}` };
      }

      try {
        const base = await resolveSafePath(root ?? deps.baseDir, deps);
        status(`Collecting files in ${base} ...`);
        const { files, truncated: fileListTruncated } = await globInSandbox(glob ?? "**/*", base, maxFiles, deps);

        status(`Searching ${files.length} files ...`);
        let scanned = 0;
        let skipped = 0;

        const perFile = await mapWithConcurrency(files, deps.defaults.maxConcurrency, async file => {
          if (signal?.aborted === true) return [] as Hit[];
          try {
            const info = await stat(file);
            if (!info.isFile() || info.size > deps.policy.maxFileBytes) {
              skipped++;
              return [] as Hit[];
            }
            const buffer = await readFile(file);
            if (looksBinary(buffer)) {
              skipped++;
              return [] as Hit[];
            }
            scanned++;

            const lines = decodeText(buffer).split(/\r?\n/);
            const hits: Hit[] = [];
            for (let index = 0; index < lines.length; index++) {
              const line = lines[index] as string;
              if (!matcher.test(line)) continue;
              hits.push({
                file,
                line: index + 1,
                text: line.slice(0, 500),
                ...(contextLines > 0
                  ? {
                      context_before: lines.slice(Math.max(0, index - contextLines), index).map(l => l.slice(0, 500)),
                      context_after: lines.slice(index + 1, index + 1 + contextLines).map(l => l.slice(0, 500)),
                    }
                  : {}),
              });
              if (hits.length >= maxMatches) break;
            }
            return hits;
          } catch {
            skipped++;
            return [] as Hit[];
          }
        });

        const all = perFile.flat();
        const matches = all.slice(0, maxMatches);

        status(`${all.length} hits in ${scanned} files`);
        return {
          pattern,
          root: base,
          files_scanned: scanned,
          files_skipped: skipped,
          total_matches: all.length,
          returned_matches: matches.length,
          truncated: all.length > matches.length || fileListTruncated,
          matches,
          ...(all.length === 0
            ? { note: "No matches. Check the glob (default '**/*'), or widen the pattern." }
            : {}),
        };
      } catch (error) {
        const message = describeError(error);
        warn(`search_in_files: ${message}`);
        return { pattern, error: message };
      }
    },
  });
}
