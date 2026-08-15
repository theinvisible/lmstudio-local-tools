import { tool } from "@lmstudio/sdk";
import { basename, resolve } from "node:path";
import { z } from "zod";
import { runProcess } from "../lib/proc";
import { resolveSafePath } from "../lib/sandbox";
import { describeError, type ToolDeps } from "./../lib/shared";

/**
 * A command is allowed when the allowlist entry matches either the bare name the model used or the
 * full path — compared case-insensitively and ignoring a .exe suffix, so "node", "node.exe" and
 * "C:\Program Files\nodejs\node.exe" all line up with an entry of "node".
 */
function normalize(command: string): string {
  return basename(command).toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "");
}

export function isCommandAllowed(command: string, allowlist: readonly string[]): boolean {
  const wanted = normalize(command);
  return allowlist.some(entry => {
    const normalized = normalize(entry);
    if (normalized === wanted) return true;
    // A full path in the allowlist must be matched exactly, not just by its base name.
    return entry.includes("/") || entry.includes("\\")
      ? resolve(entry).toLowerCase() === resolve(command).toLowerCase()
      : false;
  });
}

export function createRunCommandTool(deps: ToolDeps) {
  return tool({
    name: "run_command",
    description:
      `Run one of the commands the user has allowed (${deps.allowedCommands.join(", ")}) and return ` +
      "its exit code, stdout and stderr. Arguments are passed as a list and are never interpreted " +
      "by a shell, so pipes, redirection and && do not work — run one program at a time.",
    parameters: {
      command: z.string().describe(`The program to run. Allowed: ${deps.allowedCommands.join(", ")}.`),
      args: z.array(z.string()).optional().describe("Arguments, one array element each — not a single string."),
      cwd: z.string().optional().describe("Working directory (default: the conversation working directory)."),
    },
    implementation: async ({ command, args, cwd }, { status, warn, signal }) => {
      if (!isCommandAllowed(command, deps.allowedCommands)) {
        const message =
          `Denied: "${command}" is not on the allowed commands list. ` +
          `Allowed: ${deps.allowedCommands.join(", ")}. The user can change this in the local-tools plugin settings.`;
        warn(`run_command: ${message}`);
        return { command, error: message };
      }

      try {
        const workingDirectory = await resolveSafePath(cwd ?? deps.baseDir, deps);
        const argv = args ?? [];

        status(`Running ${command} ${argv.join(" ")} ...`);
        const result = await runProcess(command, argv, {
          cwd: workingDirectory,
          timeoutMs: deps.commandTimeoutMs,
          maxOutputChars: deps.maxOutputChars,
          ...(signal !== undefined ? { signal } : {}),
        });

        status(result.timedOut ? "Timed out" : `Exit code ${result.exitCode}`);
        return {
          command,
          args: argv,
          cwd: workingDirectory,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.truncated,
          ...(result.timedOut
            ? { error: `Killed after ${deps.commandTimeoutMs} ms — raise the command timeout in the plugin settings if needed.` }
            : {}),
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const message =
          code === "ENOENT" ? `"${command}" was not found on PATH.` : describeError(error);
        warn(`run_command: ${message}`);
        return { command, error: message };
      }
    },
  });
}
