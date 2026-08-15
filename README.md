# LM Studio Plugin: `local-tools`

Gives local LM Studio models access to *this machine* — reading and searching files inside a
sandbox you define, read-only git, allowlisted commands, notes that survive across conversations,
and small everyday helpers.

Companion to [`theinvisible/lmstudio-web-tools`](https://github.com/theinvisible/lmstudio-web-tools),
which covers everything over the network.
Kept as a separate plugin on purpose: filesystem access is a different risk class from web access,
so you can hand a chat one without the other.

## Installation

Requires [LM Studio](https://lmstudio.ai) (running) and [Node.js](https://nodejs.org) 20 or newer.

```bash
git clone https://github.com/theinvisible/lmstudio-local-tools.git
cd lmstudio-local-tools
npm install
npx lms dev --install
```

`lms` ships with LM Studio; if it is not on your PATH, run `npx lms bootstrap` once (Windows:
`%USERPROFILE%\.lmstudio\bin\lms.exe`). After installing, enable the plugin in LM Studio and load a
model that supports tool calling.

To update later: `git pull && npm install && npx lms dev --install`.

**Then configure it — out of the box it can barely do anything, on purpose.** *Allowed directories*
is empty, so the plugin only sees the conversation's working directory; *Allowed commands* is empty,
so `run_command` is not even offered. Add what you actually want it to reach in the plugin settings.

## Tools

### Files

| Tool | Parameters | Purpose |
|---|---|---|
| `read_file` | `path`, `offset_lines?`, `max_lines?`, `encoding?` | Read a text file, in pages for long ones |
| `search_in_files` | `pattern`, `root?`, `glob?`, `context_lines?`, `max_matches?`, `case_sensitive?`, `regex?`, `max_files?` | grep across many files: file, line number and context |
| `list_directory` | `path`, `recursive?`, `max_entries?`, `include_hidden?` | Names, types, sizes, modification times |
| `find_files` | `pattern`, `root?`, `max_results?` | Locate files by glob, e.g. `**/*.log` |
| `file_info` | `path` | Size, type, timestamps, symlink target — without reading the file |

### Development / system

| Tool | Parameters | Purpose |
|---|---|---|
| `git` | `repo`, `subcommand`, `ref?`, `file?`, `path?`, `max_count?`, `since?`, `staged?` | Read-only `status`, `log`, `diff`, `show`, `blame`, `branch`, `remote` |
| `run_command` | `command`, `args?`, `cwd?` | Run an allowlisted executable; only offered when the allowlist is non-empty |

### Memory and helpers

| Tool | Parameters | Purpose |
|---|---|---|
| `remember` | `key`, `content`, `tags?` | Store a note that outlives the conversation |
| `recall` | `query?`, `tags?`, `limit?` | Look up notes from any earlier chat |
| `forget` | `key` | Delete a note |
| `now` | `timezone?`, `timestamp?`, `to_timezone?` | Current date/time and time-zone conversion — so the model stops guessing the date |
| `hash` | `algorithm`, `text?` \| `file?` | md5 / sha1 / sha256 / sha512 of a string or a file |
| `encode` | `operation`, `input?` | base64 / base64url / URL / hex, `jwt_decode`, `uuid_v4` |

## The sandbox

Every path-taking tool goes through `resolveSafePath()` in `src/lib/sandbox.ts`:

1. Relative paths resolve against the conversation working directory.
2. **`realpath` on the deepest existing ancestor**, then the missing tail is re-appended. Without
   this a symlink or NTFS junction inside an allowed directory would lead straight out of it —
   resolving the string form alone is not enough. The smoke test proves this with a real junction
   to `C:\Windows`.
3. Containment is checked with `path.relative`, not `startsWith`, so `C:\data-secret` is not
   treated as living inside `C:\data`.
4. **Secrets stay blocked even inside allowed directories**: `.env*`, `id_rsa*`, `id_ed25519*`,
   `*.pem`, `*.key`, `*.pfx`, `*.kdbx`, `.git-credentials`, `.npmrc`, `.netrc`, `credentials*`,
   and anything under `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`. Extend the list in
   the settings; you cannot shorten it.

**Allowed directories default to empty**, which means only the conversation's working directory is
reachable. The plugin cannot see your disk until you add something like `H:\DEV` in the settings.

Further limits: files over *Max file size* (2 MB default) are refused with a pointer to
`offset_lines`/`max_lines`; files containing NUL bytes are reported as binary rather than dumped
into the chat.

`run_command` and `git` both use `spawn` with `shell: false` — nothing the model writes is ever
interpreted by a shell, so pipes, `&&` and redirection simply arrive as literal arguments. The child
process gets a minimal environment (`PATH`, `SystemRoot`, `TEMP`) instead of the plugin's, so
secrets in environment variables are not passed along. `git` takes typed parameters rather than a
free-form argument list, so options like `--upload-pack=` cannot be smuggled in.

## Settings

**Global** — what the model may touch: *Allowed directories* · *Additional blocked file names* ·
*Max file size* · *Allowed commands for run_command* (empty = tool not offered) · *Command timeout* ·
*Max command output* · *Memory file* · *Max stored memories* · *Enable git* · *Enable memory*.

**Per chat** — output shaping: *Max lines per file* (800) · *Max search matches* (50) ·
*Context lines* (2) · *Parallel file reads* (8). Model-supplied limits are clamped to these.

## Caveats

- **Read-only by design.** There is no `write_file`, no `mkdir`, no `move`. If you want the model to
  produce files, `lmstudio/js-code-sandbox` can write inside the conversation's working directory.
- **`run_command` is as safe as your allowlist.** Putting `powershell` or `cmd` on it hands the model
  a shell again and undoes the no-shell guarantee. Prefer specific tools (`node`, `kubectl`, `docker`).
- **Memories are a plain JSON file**, readable by anything on this machine. Do not have the model
  remember passwords or tokens.
- **`jwt_decode` does not verify signatures** — a forged token decodes just as cleanly. The tool
  says so in its own result.
- **Tool-list size**: with `web-tools` enabled too, a model sees roughly 23 tools. If a smaller model
  starts choosing badly, disable one plugin for that chat rather than merging tools together.

## Development

```powershell
npm install
npm run typecheck                    # tsc --noEmit
npx --yes tsx scripts/smoke-test.mts # 51 checks against a throwaway fixture tree, no network
npm run dev                          # lms dev — hot-reloading dev server, needs LM Studio running
npm run install-plugin               # lms dev --install — install permanently
```

Notes:

- **Do not add `"type": "module"` to `package.json`** — LM Studio bundles the plugin as CommonJS and
  the Node runner then refuses to load it (`require is not defined in ES module scope`). That is why
  the smoke test is a `.mts` file.
- **`zod` is pinned to `3.24.1`** — `@lmstudio/sdk`'s `tool()` expects zod v3; v4 breaks parameters.
- `parameters` in `tool()` is a flat record of zod schemas, not a `z.object({...})`.
- Runtime dependencies are only `@lmstudio/sdk` and `zod`: globbing uses the built-in
  `fs.promises.glob`, hashing `node:crypto`, time zones `Intl`.
