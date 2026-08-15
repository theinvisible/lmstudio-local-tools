import { tool } from "@lmstudio/sdk";
import { z } from "zod";
import { runProcess } from "../lib/proc";
import { resolveSafePath } from "../lib/sandbox";
import { describeError, type ToolDeps } from "./../lib/shared";

const SUBCOMMANDS = ["status", "log", "diff", "show", "blame", "branch", "remote"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

/**
 * Builds the argv for a read-only git invocation. Everything the model supplies goes into a
 * dedicated typed slot — there is deliberately no free-form args array, so options like
 * `--upload-pack=` or `-c core.pager=` can never be smuggled in.
 */
function buildArgs(
  subcommand: Subcommand,
  params: { ref?: string; file?: string; path?: string; max_count?: number; since?: string; staged?: boolean },
): string[] {
  const { ref, file, path, max_count, since, staged } = params;

  switch (subcommand) {
    case "status":
      return ["status", "--porcelain=v1", "--branch"];
    case "log":
      return [
        "log",
        `--max-count=${Math.min(Math.max(max_count ?? 20, 1), 500)}`,
        "--date=iso",
        "--pretty=format:%h%x09%ad%x09%an%x09%s",
        ...(since !== undefined ? [`--since=${since}`] : []),
        ...(ref !== undefined ? [ref] : []),
        ...(path !== undefined ? ["--", path] : []),
      ];
    case "diff":
      return [
        "diff",
        "--stat",
        "--patch",
        ...(staged === true ? ["--staged"] : []),
        ...(ref !== undefined ? [ref] : []),
        ...(path !== undefined ? ["--", path] : []),
      ];
    case "show":
      return ["show", "--date=iso", "--stat", "--patch", ref ?? "HEAD"];
    case "blame":
      if (file === undefined) throw new Error("blame needs the 'file' parameter.");
      return ["blame", "--date=short", "--", file];
    case "branch":
      return ["branch", "--all", "--verbose"];
    case "remote":
      return ["remote", "--verbose"];
  }
}

export function createGitTool(deps: ToolDeps) {
  return tool({
    name: "git",
    description:
      "Run read-only git commands on a local repository: status, log, diff, show, blame, branch, " +
      "remote. Use this to answer questions about a project's history — who changed what, when, and " +
      "what the current working tree looks like. It never modifies the repository.",
    parameters: {
      repo: z.string().describe("Path to the repository (or any directory inside it)."),
      subcommand: z.enum(SUBCOMMANDS).describe("Which read-only git command to run."),
      ref: z.string().optional().describe("Commit, branch or range, e.g. 'HEAD~5', 'main' or 'v1.0..v1.1'."),
      file: z.string().optional().describe("File to blame (required for the blame subcommand)."),
      path: z.string().optional().describe("Limit log/diff to this path inside the repository."),
      max_count: z.number().int().positive().optional().describe("Number of commits for log (default 20)."),
      since: z.string().optional().describe("Only commits newer than this, e.g. '2 weeks ago' or '2026-01-01'."),
      staged: z.boolean().optional().describe("For diff: show staged changes instead of unstaged ones."),
    },
    implementation: async ({ repo, subcommand, ref, file, path, max_count, since, staged }, { status, warn, signal }) => {
      try {
        const cwd = await resolveSafePath(repo, deps);
        const args = buildArgs(subcommand, { ref, file, path, max_count, since, staged });

        status(`git ${subcommand} in ${cwd} ...`);
        const result = await runProcess("git", args, {
          cwd,
          timeoutMs: deps.commandTimeoutMs,
          maxOutputChars: deps.maxOutputChars,
          ...(signal !== undefined ? { signal } : {}),
        });

        if (result.timedOut) return { repo: cwd, subcommand, error: "git timed out." };
        if (result.exitCode !== 0) {
          const detail = result.stderr !== "" ? result.stderr : result.stdout;
          warn(`git ${subcommand} exited with ${result.exitCode}`);
          return {
            repo: cwd,
            subcommand,
            exitCode: result.exitCode,
            error: detail !== "" ? detail : `git exited with code ${result.exitCode}.`,
          };
        }

        status(`git ${subcommand} done`);
        return {
          repo: cwd,
          subcommand,
          output: result.stdout,
          truncated: result.truncated,
          ...(result.stderr !== "" ? { warnings: result.stderr } : {}),
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const message =
          code === "ENOENT"
            ? "git is not installed or not on PATH, so this tool cannot run."
            : describeError(error);
        warn(`git: ${message}`);
        return { repo, subcommand, error: message };
      }
    },
  });
}
