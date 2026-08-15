import { spawn } from "node:child_process";

export interface ProcOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputChars: number;
  signal?: AbortSignal;
}

export interface ProcResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

/**
 * Runs a process with `shell: false`, so nothing the model supplies is ever interpreted by a shell:
 * no pipes, no `&&`, no globbing, no quoting bugs. Arguments go across as a plain argv array.
 *
 * The child gets a minimal environment rather than the plugin's, so secrets living in env vars are
 * not handed to whatever gets started.
 */
export function runProcess(command: string, args: string[], options: ProcOptions): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        TEMP: process.env.TEMP ?? "",
        TMP: process.env.TMP ?? "",
        NO_COLOR: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_PAGER: "cat",
      },
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const cap = (current: string, chunk: string): string => {
      if (current.length >= options.maxOutputChars) {
        truncated = true;
        return current;
      }
      const merged = current + chunk;
      if (merged.length > options.maxOutputChars) {
        truncated = true;
        return merged.slice(0, options.maxOutputChars);
      }
      return merged;
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);

    const onAbort = (): void => {
      child.kill();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout = cap(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = cap(stderr, chunk);
    });

    child.on("error", error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });

    child.on("close", code => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ exitCode: code, stdout: stdout.trim(), stderr: stderr.trim(), truncated, timedOut });
    });
  });
}
