import { tool } from "@lmstudio/sdk";
import { statfs } from "node:fs/promises";
import { arch, cpus, freemem, homedir, hostname, loadavg, platform, release, totalmem, uptime } from "node:os";
import { z } from "zod";
import { runProcess } from "../lib/proc";
import { describeError, type ToolDeps } from "./../lib/shared";

interface DiskInfo {
  mount: string;
  totalBytes: number;
  freeBytes: number;
  usedPercent: number;
}

/**
 * Disk usage without a native dependency: `fs.statfs` works on every platform, so on Windows we
 * simply probe the drive letters and keep the ones that answer.
 */
async function collectDisks(): Promise<DiskInfo[]> {
  const candidates =
    platform() === "win32"
      ? Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`)
      : ["/", "/home", homedir()];

  const disks: DiskInfo[] = [];
  const seen = new Set<string>();

  for (const mount of candidates) {
    if (seen.has(mount)) continue;
    seen.add(mount);
    try {
      const info = await statfs(mount);
      const totalBytes = Number(info.blocks) * Number(info.bsize);
      const freeBytes = Number(info.bfree) * Number(info.bsize);
      if (totalBytes === 0) continue;
      disks.push({
        mount,
        totalBytes,
        freeBytes,
        usedPercent: Math.round(((totalBytes - freeBytes) / totalBytes) * 100),
      });
    } catch {
      // Absent drive letter or unmounted path — simply not a disk we can report on.
    }
  }

  return disks;
}

interface ProcessInfo {
  name: string;
  pid: number;
  memoryBytes?: number;
  cpuPercent?: number;
}

/** Splits one line of `tasklist /fo csv`, which quotes every field and may contain commas inside them. */
function parseCsvLine(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"/g)].map(match => match[1] ?? "");
}

async function collectProcesses(deps: ToolDeps, limit: number): Promise<ProcessInfo[]> {
  const isWindows = platform() === "win32";
  const options = {
    cwd: deps.baseDir,
    timeoutMs: deps.commandTimeoutMs,
    maxOutputChars: deps.maxOutputChars,
  };

  let result = isWindows
    ? await runProcess("tasklist", ["/fo", "csv", "/nh"], options)
    : await runProcess("ps", ["-eo", "pid,comm,pcpu,pmem", "--sort=-pmem"], options);

  // --sort is a GNU extension; BSD ps (macOS) rejects it, so fall back to unsorted output.
  if (!isWindows && result.exitCode !== 0) {
    result = await runProcess("ps", ["-eo", "pid,comm,pcpu,pmem"], options);
  }

  if (result.exitCode !== 0) return [];

  const processes: ProcessInfo[] = [];

  if (isWindows) {
    for (const line of result.stdout.split(/\r?\n/)) {
      const fields = parseCsvLine(line);
      if (fields.length < 5) continue;
      const pid = Number(fields[1]);
      // "12.345 K" -> bytes
      const memoryBytes = Number((fields[4] ?? "").replace(/[^\d]/g, "")) * 1024;
      if (!Number.isFinite(pid)) continue;
      processes.push({ name: fields[0] ?? "", pid, memoryBytes });
    }
    processes.sort((a, b) => (b.memoryBytes ?? 0) - (a.memoryBytes ?? 0));
  } else {
    for (const line of result.stdout.split(/\r?\n/).slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;
      const pid = Number(parts[0]);
      if (!Number.isFinite(pid)) continue;
      processes.push({ name: parts[1] ?? "", pid, cpuPercent: Number(parts[2]), memoryBytes: undefined });
    }
  }

  return processes.slice(0, limit);
}

export function createSystemInfoTool(deps: ToolDeps) {
  return tool({
    name: "system_info",
    description:
      "Report what this machine looks like right now: operating system, CPU, RAM in use, uptime, " +
      "and how full each disk is. Optionally the processes using the most memory. Use it for " +
      "'how much space is left', 'how much RAM is free' and 'what is eating memory'.",
    parameters: {
      include_processes: z
        .boolean()
        .optional()
        .describe("Also list the biggest processes by memory (default false). On Windows no CPU figures are available."),
      max_processes: z.number().int().min(1).max(100).optional().describe("How many processes to list (default 15)."),
    },
    implementation: async ({ include_processes, max_processes }, { status, warn }) => {
      try {
        status("Collecting system information ...");

        const cpuList = cpus();
        const total = totalmem();
        const free = freemem();

        const disks = await collectDisks();

        let processes: ProcessInfo[] | undefined;
        if (include_processes === true) {
          status("Listing processes ...");
          processes = await collectProcesses(deps, max_processes ?? 15);
          if (processes.length === 0) warn("Could not read the process list on this system.");
        }

        status("Done");
        return {
          os: {
            platform: platform(),
            release: release(),
            arch: arch(),
            hostname: hostname(),
            uptimeSeconds: Math.round(uptime()),
            ...(platform() === "win32" ? {} : { loadAverage: loadavg() }),
          },
          cpu: {
            model: cpuList[0]?.model?.trim(),
            cores: cpuList.length,
            speedMhz: cpuList[0]?.speed,
          },
          memory: {
            totalBytes: total,
            freeBytes: free,
            usedPercent: total === 0 ? 0 : Math.round(((total - free) / total) * 100),
          },
          disks,
          ...(processes !== undefined
            ? {
                processes,
                ...(platform() === "win32"
                  ? { processNote: "tasklist reports memory only — CPU usage per process is not available here." }
                  : {}),
              }
            : {}),
        };
      } catch (error) {
        const message = describeError(error);
        warn(`system_info: ${message}`);
        return { error: message };
      }
    },
  });
}
