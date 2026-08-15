# Changelog

All notable changes to this plugin are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/).

## [1.1.0] — 2026-08-15

### Added

- **`read_file` can read from the end**: `last_lines` returns the tail of a file, which is what you
  want for logs — previously the only way there was to fetch the line count first and compute an
  offset. `show_line_numbers` prefixes each line with its real position.
- **`system_info` tool**: operating system, CPU, memory, uptime and per-disk usage, plus optionally
  the processes using the most memory. Disk usage uses the built-in `fs.statfs`, so no native
  dependency is involved.
- **Semantic memory search**: `recall` ranks notes by meaning using an embedding model, so "which
  editor does he use" finds a note about CLion. Notes written earlier are indexed on demand. Without
  an embedding model loaded, recall falls back to keyword matching and says so in its result — the
  fallback is the normal path, not an error.

### Changed

- CI runs the full offline suite on Linux and Windows across Node 22 and 24. The suite is now
  platform-aware: the sandbox-escape fixtures use `C:\Windows` and junctions on Windows, `/etc` and
  symlinks elsewhere.
- `ps` falls back to unsorted output when `--sort` is unavailable (BSD `ps` on macOS).

### Fixed

- All sandbox refusals now start with `Denied:`; the file-size limit was the odd one out.
- The smoke suite sets `process.exitCode` instead of calling `process.exit()`, which tripped a libuv
  assertion on Windows while child processes were still closing.

## [1.0.0] — 2026-08-14

### Added

- Initial release: `read_file`, `search_in_files`, `list_directory`, `find_files`, `file_info`,
  read-only `git`, allowlisted `run_command`, `remember`/`recall`/`forget`, `now`, `hash`, `encode`.
- Path sandbox with `realpath` resolution (defeating symlink and junction escapes), containment via
  `path.relative`, and a secret block list that applies inside allowed directories too.
