/**
 * Standalone smoke test — builds a throwaway fixture tree, exercises the sandbox and every tool,
 * then cleans up. Run with:  npx --yes tsx scripts/smoke-test.mts
 *
 * Nothing here touches the network, and nothing is written outside the fixture directory.
 */
import { spawnSync } from "node:child_process";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxPolicy } from "../src/lib/sandbox";
import type { ToolDeps } from "../src/lib/shared";
import { createEncodeTool } from "../src/tools/encode";
import { createFileInfoTool } from "../src/tools/fileInfo";
import { createFindFilesTool } from "../src/tools/findFiles";
import { createGitTool } from "../src/tools/git";
import { createHashTool } from "../src/tools/hash";
import { createListDirectoryTool } from "../src/tools/listDirectory";
import { createMemoryTools } from "../src/tools/memory";
import { createNowTool } from "../src/tools/now";
import { createReadFileTool } from "../src/tools/readFile";
import { createRunCommandTool, isCommandAllowed } from "../src/tools/runCommand";
import { createSearchInFilesTool } from "../src/tools/searchInFiles";

const FIXTURE = join(tmpdir(), `lms-local-tools-smoke-${process.pid}`);
const DATA = join(FIXTURE, "data");
const SECRET_SIBLING = join(FIXTURE, "data-secret");
const REPO = join(DATA, "repo");

const ctx = {
  status: (text: string) => console.log(`      · ${text}`),
  warn: (text: string) => console.log(`      ! ${text}`),
  signal: new AbortController().signal,
};

let failures = 0;
let skipped = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) {
    failures++;
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail).slice(0, 400)}`);
  }
}

function skip(label: string, reason: string): void {
  skipped++;
  console.log(`  SKIP  ${label}\n        ${reason}`);
}

async function denied(label: string, run: () => Promise<any>): Promise<void> {
  const result = await run();
  const ok = typeof result?.error === "string" && /Denied|not a regular file|binary/i.test(result.error);
  check(label, ok, result);
  if (ok) console.log(`        -> ${String(result.error).slice(0, 130)}`);
}

// ---------------------------------------------------------------- fixture

await rm(FIXTURE, { recursive: true, force: true });
await mkdir(join(DATA, "sub"), { recursive: true });
await mkdir(join(DATA, "node_modules", "pkg"), { recursive: true });
await mkdir(SECRET_SIBLING, { recursive: true });

const HELLO_LINES = Array.from({ length: 10 }, (_, i) =>
  i === 6 ? "line 7 contains the UNIQUE_MARKER_42 token" : `line ${i + 1}`,
);
await writeFile(join(DATA, "hello.txt"), HELLO_LINES.join("\n"), "utf-8");
await writeFile(join(DATA, "notes.md"), "# Notes\n\nnothing to see", "utf-8");
await writeFile(join(DATA, "sub", "deep.txt"), "deep file with UNIQUE_MARKER_42 as well", "utf-8");
await writeFile(join(DATA, ".env"), "SECRET_TOKEN=hunter2", "utf-8");
await writeFile(join(DATA, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----", "utf-8");
await writeFile(join(DATA, "big.txt"), "x".repeat(200_000), "utf-8");
await writeFile(join(DATA, "binary.dat"), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
await writeFile(join(DATA, "node_modules", "pkg", "index.js"), "// UNIQUE_MARKER_42 in node_modules", "utf-8");
await writeFile(join(SECRET_SIBLING, "leak.txt"), "this must never be readable", "utf-8");

let junctionMade = false;
try {
  await symlink("C:\\Windows", join(DATA, "link-out"), "junction");
  junctionMade = true;
} catch {
  junctionMade = false;
}

const policy: SandboxPolicy = { allowedRoots: [DATA], deniedPatterns: [], maxFileBytes: 100_000 };
const deps: ToolDeps = {
  policy,
  baseDir: DATA,
  allowedCommands: [],
  commandTimeoutMs: 15_000,
  maxOutputChars: 50_000,
  memoryFile: join(FIXTURE, "memories.json"),
  maxMemories: 100,
  defaults: { maxLines: 500, maxMatches: 50, contextLines: 2, maxConcurrency: 8 },
};

const readFileTool = createReadFileTool(deps);

// ---------------------------------------------------------------- 1. sandbox

console.log("\n=== 1. Path sandbox ===");
await denied("absolute path outside the roots (C:\\Windows\\win.ini)", () =>
  readFileTool.implementation({ path: "C:\\Windows\\win.ini" }, ctx),
);
await denied("traversal out of the root (../../Windows/win.ini)", () =>
  readFileTool.implementation({ path: "../../Windows/win.ini" }, ctx),
);
await denied("prefix trap: <fixture>/data-secret is not inside <fixture>/data", () =>
  readFileTool.implementation({ path: join(SECRET_SIBLING, "leak.txt") }, ctx),
);
await denied(".env inside an allowed root", () => readFileTool.implementation({ path: ".env" }, ctx));
await denied("id_rsa inside an allowed root", () => readFileTool.implementation({ path: "id_rsa" }, ctx));

if (junctionMade) {
  await denied("junction escaping the root (link-out -> C:\\Windows)", () =>
    readFileTool.implementation({ path: "link-out\\win.ini" }, ctx),
  );
} else {
  skip("junction escaping the root", "could not create a junction here — realpath escape not exercised");
}

await denied("file over the size limit", () => readFileTool.implementation({ path: "big.txt" }, ctx));
await denied("binary file is reported, not dumped", () => readFileTool.implementation({ path: "binary.dat" }, ctx));

// ---------------------------------------------------------------- 2. file tools

console.log("\n=== 2. read_file / list_directory / find_files / file_info ===");
const whole = (await readFileTool.implementation({ path: "hello.txt" }, ctx)) as any;
check("reads a file", whole.total_lines === 10 && String(whole.content).startsWith("line 1"), whole);

const slice = (await readFileTool.implementation({ path: "hello.txt", offset_lines: 7, max_lines: 2 }, ctx)) as any;
check(
  "offset_lines / max_lines return exactly that window",
  slice.first_line === 7 && slice.returned_lines === 2 && String(slice.content).includes("UNIQUE_MARKER_42"),
  slice,
);

const listing = (await createListDirectoryTool(deps).implementation({ path: ".", recursive: true }, ctx)) as any;
const names = (listing.entries ?? []).map((e: any) => e.name);
check("lists fixture files", names.some((n: string) => n === "hello.txt"), names.slice(0, 10));
check(
  "does not descend into node_modules",
  !names.some((n: string) => String(n).includes("pkg")),
  names.filter((n: string) => String(n).includes("node_modules")),
);
check("hides dot-files by default", !names.includes(".env"), names);

const found = (await createFindFilesTool(deps).implementation({ pattern: "**/*.txt" }, ctx)) as any;
check("find_files matches the glob", found.count >= 3, found);
check(
  "find_files does not surface denied names",
  !(found.files ?? []).some((f: string) => f.endsWith("id_rsa")),
  found.files,
);

const info = (await createFileInfoTool(deps).implementation({ path: "hello.txt" }, ctx)) as any;
check("file_info reports type and size", info.type === "file" && info.size > 0, info);
const missing = (await createFileInfoTool(deps).implementation({ path: "nope.txt" }, ctx)) as any;
check("missing file reports exists:false, not an error", missing.exists === false, missing);

// ---------------------------------------------------------------- 3. search_in_files

console.log("\n=== 3. search_in_files ===");
const search = createSearchInFilesTool(deps);
const hits = (await search.implementation({ pattern: "UNIQUE_MARKER_42", glob: "**/*.txt" }, ctx)) as any;
check("finds the marker", hits.total_matches >= 2, hits);
const helloHit = (hits.matches ?? []).find((m: any) => String(m.file).endsWith("hello.txt"));
check("reports the correct line number", helloHit?.line === 7, helloHit);
check("returns context lines", Array.isArray(helloHit?.context_before) && helloHit.context_before.length > 0, helloHit);
const noHits = (await search.implementation({ pattern: "zzz-definitely-not-here", glob: "**/*.txt" }, ctx)) as any;
check("no hits is a result, not an error", noHits.total_matches === 0 && noHits.error === undefined, noHits);

// ---------------------------------------------------------------- 4. git

console.log("\n=== 4. git (read-only) ===");
const gitAvailable = spawnSync("git", ["--version"], { shell: false }).status === 0;
if (!gitAvailable) {
  skip("git subcommands", "git is not on PATH in this environment");
} else {
  await mkdir(REPO, { recursive: true });
  const git = (args: string[]) => spawnSync("git", args, { cwd: REPO, shell: false });
  git(["init", "--quiet"]);
  git(["config", "user.email", "smoke@example.com"]);
  git(["config", "user.name", "Smoke Test"]);
  await writeFile(join(REPO, "file.txt"), "first version\n", "utf-8");
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "initial commit"]);
  await writeFile(join(REPO, "file.txt"), "second version\n", "utf-8");

  const gitTool = createGitTool(deps);
  const log = (await gitTool.implementation({ repo: REPO, subcommand: "log" }, ctx)) as any;
  check("git log shows the commit", String(log.output).includes("initial commit"), log);
  const st = (await gitTool.implementation({ repo: REPO, subcommand: "status" }, ctx)) as any;
  check("git status sees the modification", String(st.output).includes("file.txt"), st);
  const diff = (await gitTool.implementation({ repo: REPO, subcommand: "diff" }, ctx)) as any;
  check("git diff shows the change", String(diff.output).includes("second version"), diff);
  const show = (await gitTool.implementation({ repo: REPO, subcommand: "show" }, ctx)) as any;
  check("git show works", String(show.output).includes("first version"), show);
  const outside = (await gitTool.implementation({ repo: "C:\\Windows", subcommand: "status" }, ctx)) as any;
  check("git refuses a repo outside the sandbox", String(outside.error).includes("Denied"), outside);
}

// ---------------------------------------------------------------- 5. run_command

console.log("\n=== 5. run_command ===");
check("empty allowlist means nothing is allowed", !isCommandAllowed("node", []), { allowed: isCommandAllowed("node", []) });
check("allowlist matches ignoring .exe and case", isCommandAllowed("NODE.exe", ["node"]), {});
check("unrelated command stays denied", !isCommandAllowed("curl", ["node"]), {});

const runDeps: ToolDeps = { ...deps, allowedCommands: ["node"] };
const runTool = createRunCommandTool(runDeps);
const ran = (await runTool.implementation({ command: "node", args: ["-e", "console.log(42)"] }, ctx)) as any;
check("runs an allowed command", ran.exitCode === 0 && String(ran.stdout).trim() === "42", ran);
const refused = (await runTool.implementation({ command: "curl", args: ["https://example.com"] }, ctx)) as any;
check("refuses a command not on the list", String(refused.error).includes("not on the allowed"), refused);
const noShell = (await runTool.implementation({ command: "node", args: ["-e", "console.log(1)", "&&", "whoami"] }, ctx)) as any;
check("no shell: && is a literal argument, not an operator", noShell.exitCode === 0, noShell);

// ---------------------------------------------------------------- 6. memory

console.log("\n=== 6. remember / recall / forget ===");
const [remember, recall, forget] = createMemoryTools(deps) as any[];
await remember.implementation({ key: "preferred-editor", content: "Uses CLion for C++ work", tags: ["prefs"] }, ctx);
const recalled = (await recall.implementation({ query: "editor" }, ctx)) as any;
check("recall finds what was remembered", recalled.memories?.[0]?.key === "preferred-editor", recalled);

await remember.implementation({ key: "preferred-editor", content: "Uses CLion and VS Code", tags: ["prefs"] }, ctx);
const updated = (await recall.implementation({ query: "editor" }, ctx)) as any;
check(
  "storing the same key updates instead of duplicating",
  updated.count === 1 && String(updated.memories[0].content).includes("VS Code"),
  updated,
);

await Promise.all(
  Array.from({ length: 5 }, (_, i) =>
    remember.implementation({ key: `parallel-${i}`, content: `entry ${i}`, tags: ["par"] }, ctx),
  ),
);
const parallel = (await recall.implementation({ tags: ["par"], limit: 20 }, ctx)) as any;
check("five concurrent writes all survive", parallel.count === 5, { count: parallel.count });

const gone = (await forget.implementation({ key: "preferred-editor" }, ctx)) as any;
const afterForget = (await recall.implementation({ query: "editor" }, ctx)) as any;
check("forget removes the entry", gone.removed === true && afterForget.count === 0, { gone, afterForget });
const forgetMissing = (await forget.implementation({ key: "never-existed" }, ctx)) as any;
check("forgetting something absent is not an error", forgetMissing.removed === false && !forgetMissing.error, forgetMissing);

// ---------------------------------------------------------------- 7. now / hash / encode

console.log("\n=== 7. now / hash / encode ===");
const nowTool = createNowTool();
const nowResult = (await nowTool.implementation({ timezone: "Europe/Vienna", to_timezone: "Asia/Tokyo" }, ctx)) as any;
check("now reports both time zones", nowResult.primary?.timezone === "Europe/Vienna" && nowResult.converted?.timezone === "Asia/Tokyo", nowResult);
check("now returns a plausible ISO timestamp", !Number.isNaN(Date.parse(nowResult.iso)), nowResult.iso);
const converted = (await nowTool.implementation({ timestamp: "2026-01-15T12:00:00Z", to_timezone: "Asia/Tokyo" }, ctx)) as any;
check(
  "converts a given instant (12:00 UTC -> 21:00 in Tokyo)",
  String(converted.converted?.formatted).includes("21:00"),
  converted.converted,
);
const badZone = (await nowTool.implementation({ timezone: "Mars/Olympus" }, ctx)) as any;
check("unknown time zone is a readable error", typeof badZone.error === "string", badZone);

const hashTool = createHashTool(deps);
const abc = (await hashTool.implementation({ algorithm: "sha256", text: "abc" }, ctx)) as any;
check(
  "sha256('abc') matches the known vector",
  abc.hash === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  abc,
);
const fileHash = (await hashTool.implementation({ algorithm: "sha256", file: "hello.txt" }, ctx)) as any;
check("hashes a file inside the sandbox", typeof fileHash.hash === "string" && fileHash.hash.length === 64, fileHash);
const hashDenied = (await hashTool.implementation({ algorithm: "sha256", file: ".env" }, ctx)) as any;
check("hash respects the secret block list", String(hashDenied.error).includes("Denied"), hashDenied);
const bothInputs = (await hashTool.implementation({ algorithm: "md5", text: "a", file: "hello.txt" }, ctx)) as any;
check("hash rejects giving both text and file", typeof bothInputs.error === "string", bothInputs);

const encodeTool = createEncodeTool();
const b64 = (await encodeTool.implementation({ operation: "base64_encode", input: "Grüße" }, ctx)) as any;
const b64back = (await encodeTool.implementation({ operation: "base64_decode", input: b64.result }, ctx)) as any;
check("base64 round-trip survives umlauts", b64back.result === "Grüße", { b64, b64back });
const hex = (await encodeTool.implementation({ operation: "hex_encode", input: "hi" }, ctx)) as any;
check("hex encoding", hex.result === "6869", hex);
const uuid = (await encodeTool.implementation({ operation: "uuid_v4" }, ctx)) as any;
check("uuid looks like a uuid", /^[0-9a-f-]{36}$/.test(String(uuid.result)), uuid);
// Standard example token from jwt.io — signature is intentionally not verified.
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const jwt = (await encodeTool.implementation({ operation: "jwt_decode", input: JWT }, ctx)) as any;
check("jwt payload decoded", (jwt.payload as any)?.name === "John Doe", jwt);
check("jwt issued_at rendered as a date", String(jwt.issued_at).startsWith("2018-"), jwt);
check("jwt result states the signature was not verified", String(jwt.note).includes("NOT verified"), jwt);

// ---------------------------------------------------------------- cleanup

await rm(FIXTURE, { recursive: true, force: true });

console.log(
  `\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}` +
    (skipped > 0 ? ` (${skipped} skipped)` : "") +
    "\n",
);
process.exit(failures === 0 ? 0 : 1);
