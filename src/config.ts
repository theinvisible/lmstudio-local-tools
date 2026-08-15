import { createConfigSchematics } from "@lmstudio/sdk";

/**
 * Global settings — everything that decides what the model may touch on this machine. Deliberately
 * not per-chat: a switch for "may read my whole D: drive" must not be flippable by accident.
 */
export const globalConfigSchematics = createConfigSchematics()
  .field(
    "allowedRoots",
    "stringArray",
    {
      displayName: "Allowed directories",
      subtitle:
        "Absolute paths the tools may read, e.g. D:\\Projects or /home/you/code. Subdirectories are included. " +
        "Empty = only this conversation's working directory, so the plugin cannot reach your disk until you add something here.",
      allowEmptyStrings: false,
      maxNumItems: 20,
    },
    [] as string[],
  )
  .field(
    "deniedPatterns",
    "stringArray",
    {
      displayName: "Additional blocked file names",
      subtitle:
        "Glob patterns on the file name, e.g. *.p8 or backup-*.sql. Added on top of the built-in list " +
        "(.env, id_rsa, *.pem, *.key, credentials, ... and the .ssh/.aws/.gnupg/.kube directories), which is always active.",
      allowEmptyStrings: false,
      maxNumItems: 50,
    },
    [] as string[],
  )
  .field(
    "maxFileBytes",
    "numeric",
    {
      displayName: "Max file size (bytes)",
      subtitle: "Larger files are refused; read them in parts with offset_lines / max_lines instead.",
      min: 1_000,
      max: 100_000_000,
      int: true,
    },
    2_000_000,
  )
  .field(
    "allowedCommands",
    "stringArray",
    {
      displayName: "Allowed commands for run_command",
      subtitle:
        "Executables the model may start, e.g. node, python, kubectl — by name or full path. " +
        "Empty = run_command is not offered to the model at all. Commands run without a shell: no pipes, no &&.",
      allowEmptyStrings: false,
      maxNumItems: 30,
    },
    [] as string[],
  )
  .field(
    "commandTimeoutMs",
    "numeric",
    {
      displayName: "Command timeout (ms)",
      subtitle: "Applies to run_command and git.",
      min: 1_000,
      max: 600_000,
      int: true,
    },
    30_000,
  )
  .field(
    "maxOutputChars",
    "numeric",
    {
      displayName: "Max command output (characters)",
      subtitle: "stdout and stderr are cut off at this length.",
      min: 1_000,
      max: 1_000_000,
      int: true,
    },
    100_000,
  )
  .field(
    "memoryFile",
    "string",
    {
      displayName: "Memory file",
      subtitle: "Where remember/recall store their notes. Empty = <home>/.lmstudio/local-tools-memories.json",
    },
    "",
  )
  .field(
    "maxMemories",
    "numeric",
    {
      displayName: "Max stored memories",
      subtitle: "When full, remember refuses instead of silently discarding an older note.",
      min: 10,
      max: 10_000,
      int: true,
    },
    500,
  )
  .field(
    "enableSemanticRecall",
    "boolean",
    {
      displayName: "Semantic memory search",
      subtitle:
        "Rank recall results by meaning instead of matching substrings, so 'which editor' finds a note about CLion. " +
        "Needs an embedding model loaded in LM Studio — without one, recall silently falls back to keyword matching.",
    },
    true,
  )
  .field(
    "embeddingModel",
    "string",
    {
      displayName: "Embedding model",
      subtitle:
        "Model key for semantic recall, e.g. text-embedding-nomic-embed-text-v1.5. " +
        "Empty = use whichever embedding model is already loaded (never loads one by itself).",
    },
    "",
  )
  .field(
    "enableSystemInfo",
    "boolean",
    {
      displayName: "Enable system_info tool",
      subtitle: "Reports OS, CPU, RAM, disks and optionally processes. Includes this machine's hostname.",
    },
    true,
  )
  .field(
    "enableGit",
    "boolean",
    { displayName: "Enable git tool", subtitle: "Read-only git subcommands on repositories inside the allowed directories." },
    true,
  )
  .field(
    "enableMemory",
    "boolean",
    { displayName: "Enable remember / recall / forget", subtitle: "Persistent notes that survive across conversations." },
    true,
  )
  .build();

/** Per-chat settings — output shaping only. Safe to tweak per conversation. */
export const configSchematics = createConfigSchematics()
  .field(
    "maxLines",
    "numeric",
    {
      displayName: "Max lines per file",
      subtitle: "Upper bound for read_file. The model can ask for fewer, never for more.",
      min: 10,
      max: 20_000,
      int: true,
    },
    800,
  )
  .field(
    "maxMatches",
    "numeric",
    {
      displayName: "Max search matches",
      subtitle: "Upper bound for search_in_files.",
      min: 1,
      max: 500,
      int: true,
    },
    50,
  )
  .field(
    "contextLines",
    "numeric",
    {
      displayName: "Context lines around a match",
      subtitle: "How many lines before and after each search hit are returned.",
      min: 0,
      max: 20,
      int: true,
    },
    2,
  )
  .field(
    "maxConcurrency",
    "numeric",
    {
      displayName: "Parallel file reads",
      subtitle: "How many files search_in_files scans at the same time.",
      min: 1,
      max: 32,
      int: true,
    },
    8,
  )
  .build();
