import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface SandboxPolicy {
  /** Directories the tools may touch. Always contains at least the conversation working directory. */
  allowedRoots: string[];
  /** Extra glob patterns (matched against the file name) on top of the built-in secret list. */
  deniedPatterns: string[];
  maxFileBytes: number;
}

/** A refusal the model is meant to read and relay, not an unexpected crash. */
export class PathDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathDeniedError";
  }
}

/**
 * Files that stay off limits even inside an allowed root. Someone pointing the sandbox at their
 * home directory should not hand the model their SSH keys along with it.
 */
const DENIED_NAME_PATTERNS = [
  ".env",
  ".env.*",
  "*.env",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  "*.pem",
  "*.key",
  "*.pfx",
  "*.p12",
  "*.kdbx",
  "*.ppk",
  ".git-credentials",
  ".npmrc",
  ".netrc",
  "_netrc",
  "credentials",
  "credentials.json",
  "secrets.json",
  "*.jks",
  "*.keystore",
];

/** Any path with one of these directory segments is refused outright. */
const DENIED_SEGMENTS = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker"]);

/** Directories that are listed but never descended into, because they drown out everything else. */
export const NOISY_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  "target",
  ".venv",
  "__pycache__",
  ".next",
  ".cache",
]);

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

export function isDeniedName(name: string, extraPatterns: readonly string[] = []): boolean {
  return [...DENIED_NAME_PATTERNS, ...extraPatterns].some(pattern => globToRegExp(pattern).test(name));
}

function hasDeniedSegment(target: string): boolean {
  return target
    .split(/[\\/]/)
    .some(segment => DENIED_SEGMENTS.has(segment.toLowerCase()));
}

/** True when `target` is `root` itself or lives underneath it. Case-insensitive on Windows. */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Resolves the deepest existing ancestor with `realpath` and re-appends the missing tail. Without
 * this a symlink or NTFS junction sitting inside an allowed root would lead straight out of it —
 * resolving only the string form of the path is not enough.
 */
async function realpathOrNearest(target: string): Promise<string> {
  let current = resolve(target);
  const missing: string[] = [];

  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length === 0 ? real : join(real, ...[...missing].reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(target); // reached the drive root, nothing resolved
      missing.push(basename(current));
      current = parent;
    }
  }
}

export interface SandboxContext {
  policy: SandboxPolicy;
  /** Relative paths are resolved against this (the conversation working directory). */
  baseDir: string;
}

/**
 * The single gate every path-taking tool goes through. Returns the real, absolute path or throws a
 * {@link PathDeniedError} whose message tells the model (and the user) how to fix it.
 */
export async function resolveSafePath(input: string, ctx: SandboxContext): Promise<string> {
  const raw = input.trim();
  if (raw === "") throw new PathDeniedError("No path given.");

  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(ctx.baseDir, raw);
  const real = await realpathOrNearest(absolute);

  if (hasDeniedSegment(real)) {
    throw new PathDeniedError(
      `Denied: "${real}" lies in a credential directory (.ssh, .gnupg, .aws, .kube, ...). These are always off limits.`,
    );
  }
  if (isDeniedName(basename(real), ctx.policy.deniedPatterns)) {
    throw new PathDeniedError(
      `Denied: "${basename(real)}" looks like a secret (key, certificate, .env, credentials). These are blocked even inside allowed directories.`,
    );
  }

  const roots = await Promise.all(ctx.policy.allowedRoots.map(root => realpathOrNearest(root)));
  if (!roots.some(root => isInside(root, real))) {
    throw new PathDeniedError(
      `Denied: "${real}" is outside the allowed directories (${roots.join(", ")}). ` +
        `Add the directory to "Allowed directories" in the local-tools plugin settings if this is intended.`,
    );
  }

  return real;
}

export interface FileGuardResult {
  path: string;
  size: number;
}

/** Path check plus the checks that only make sense for a file you are about to read. */
export async function resolveReadableFile(input: string, ctx: SandboxContext): Promise<FileGuardResult> {
  const path = await resolveSafePath(input, ctx);

  let info;
  try {
    info = await stat(path);
  } catch (error) {
    throw new PathDeniedError(`Cannot read "${path}": ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
  }
  if (info.isDirectory()) {
    throw new PathDeniedError(`"${path}" is a directory — use list_directory instead.`);
  }
  if (!info.isFile()) {
    throw new PathDeniedError(`"${path}" is not a regular file.`);
  }
  if (info.size > ctx.policy.maxFileBytes) {
    throw new PathDeniedError(
      `Denied: "${path}" is ${info.size} bytes, over the ${ctx.policy.maxFileBytes} byte limit. ` +
        `Read part of it with offset_lines/max_lines, or raise "Max file size" in the plugin settings.`,
    );
  }

  return { path, size: info.size };
}

/** Heuristic used to refuse dumping binary content into the conversation. */
export function looksBinary(buffer: Buffer): boolean {
  const window = buffer.subarray(0, Math.min(buffer.length, 8192));
  return window.includes(0);
}

/** Strips a UTF-8 BOM, which otherwise shows up as a stray character on the first line. */
export function decodeText(buffer: Buffer, encoding: BufferEncoding = "utf-8"): string {
  const text = buffer.toString(encoding);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
