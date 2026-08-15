import type { Tool, ToolsProviderController } from "@lmstudio/sdk";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { configSchematics, globalConfigSchematics } from "./config";
import type { SandboxPolicy } from "./lib/sandbox";
import type { ToolDeps } from "./lib/shared";
import { createEncodeTool } from "./tools/encode";
import { createFileInfoTool } from "./tools/fileInfo";
import { createFindFilesTool } from "./tools/findFiles";
import { createGitTool } from "./tools/git";
import { createHashTool } from "./tools/hash";
import { createListDirectoryTool } from "./tools/listDirectory";
import { createMemoryTools } from "./tools/memory";
import { createNowTool } from "./tools/now";
import { createReadFileTool } from "./tools/readFile";
import { createRunCommandTool } from "./tools/runCommand";
import { createSearchInFilesTool } from "./tools/searchInFiles";
import { createSystemInfoTool } from "./tools/systemInfo";

/** The working directory is our default sandbox root, so a broken one must not silently become "/". */
function safeWorkingDirectory(ctl: ToolsProviderController): string {
  try {
    const directory = ctl.getWorkingDirectory();
    if (typeof directory === "string" && directory.trim() !== "") return directory;
  } catch {
    // fall through
  }
  return tmpdir();
}

export async function toolsProvider(ctl: ToolsProviderController): Promise<Tool[]> {
  const config = ctl.getPluginConfig(configSchematics);
  const globalConfig = ctl.getGlobalPluginConfig(globalConfigSchematics);

  const baseDir = safeWorkingDirectory(ctl);
  const configuredRoots = globalConfig.get("allowedRoots").filter(entry => entry.trim() !== "");

  const policy: SandboxPolicy = {
    // The working directory is always reachable; anything beyond it is opt-in.
    allowedRoots: [baseDir, ...configuredRoots],
    deniedPatterns: globalConfig.get("deniedPatterns").filter(entry => entry.trim() !== ""),
    maxFileBytes: globalConfig.get("maxFileBytes"),
  };

  const configuredMemoryFile = globalConfig.get("memoryFile").trim();

  const deps: ToolDeps = {
    policy,
    baseDir,
    allowedCommands: globalConfig.get("allowedCommands").filter(entry => entry.trim() !== ""),
    commandTimeoutMs: globalConfig.get("commandTimeoutMs"),
    maxOutputChars: globalConfig.get("maxOutputChars"),
    memoryFile:
      configuredMemoryFile !== "" ? configuredMemoryFile : join(homedir(), ".lmstudio", "local-tools-memories.json"),
    maxMemories: globalConfig.get("maxMemories"),
    enableSemanticRecall: globalConfig.get("enableSemanticRecall"),
    embeddingModel: globalConfig.get("embeddingModel"),
    defaults: {
      maxLines: config.get("maxLines"),
      maxMatches: config.get("maxMatches"),
      contextLines: config.get("contextLines"),
      maxConcurrency: config.get("maxConcurrency"),
    },
  };

  const tools: Tool[] = [
    createReadFileTool(deps),
    createSearchInFilesTool(deps),
    createListDirectoryTool(deps),
    createFindFilesTool(deps),
    createFileInfoTool(deps),
    createNowTool(),
    createHashTool(deps),
    createEncodeTool(),
  ];

  if (globalConfig.get("enableSystemInfo")) tools.push(createSystemInfoTool(deps));
  if (globalConfig.get("enableGit")) tools.push(createGitTool(deps));
  // No allowlist means no runnable commands, so the tool is not offered at all rather than being
  // advertised and then refusing every call.
  if (deps.allowedCommands.length > 0) tools.push(createRunCommandTool(deps));
  if (globalConfig.get("enableMemory")) tools.push(...createMemoryTools(deps));

  return tools;
}
