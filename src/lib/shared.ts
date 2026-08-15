import { PathDeniedError, type SandboxPolicy } from "./sandbox";

export interface ToolDeps {
  policy: SandboxPolicy;
  /** Conversation working directory; relative paths resolve against it. */
  baseDir: string;
  allowedCommands: string[];
  commandTimeoutMs: number;
  maxOutputChars: number;
  memoryFile: string;
  maxMemories: number;
  defaults: {
    maxLines: number;
    maxMatches: number;
    contextLines: number;
    maxConcurrency: number;
  };
}

/**
 * Turns any thrown value into a short string the model can act on. Status updates and warnings only
 * reach the UI — whatever the model should know has to be in the return value.
 */
export function describeError(error: unknown): string {
  const name = (error as { name?: string } | null)?.name;
  if (name === "AbortError") return "Aborted by the user.";
  if (error instanceof PathDeniedError) return error.message;
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== undefined ? `Error (${code}): ${error.message}` : `Error: ${error.message}`;
  }
  return `Error: ${String(error)}`;
}

export function isAbort(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === "AbortError";
}

/** Clamps a model-supplied limit so a single tool call cannot blow past the configured budget. */
export function clamp(requested: number | undefined, configured: number): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return configured;
  return Math.min(Math.trunc(requested), configured);
}

/** Runs tasks with a bounded number in flight, preserving input order in the results. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  });

  await Promise.all(runners);
  return results;
}

export function truncateText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, maxChars)}\n\n[... truncated, ${value.length - maxChars} more characters]`,
    truncated: true,
  };
}
