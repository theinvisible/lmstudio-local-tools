import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface MemoryEntry {
  key: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface MemoryFile {
  version: 1;
  entries: MemoryEntry[];
}

export class MemoryLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryLimitError";
  }
}

/**
 * Notes that survive across conversations, kept in one JSON file.
 *
 * Every mutation goes through {@link serialize}, so two tool calls in flight at the same time
 * cannot lose each other's write, and the file itself is replaced by an atomic rename so a crash
 * mid-write cannot leave a half-written file behind.
 */
export class MemoryStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly maxEntries: number,
  ) {}

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async load(): Promise<MemoryFile> {
    try {
      const raw = await readFile(this.file, "utf-8");
      const parsed = JSON.parse(raw) as Partial<MemoryFile>;
      return { version: 1, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
    } catch {
      // Missing or unreadable file simply means "no memories yet".
      return { version: 1, entries: [] };
    }
  }

  private async save(data: MemoryFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = join(dirname(this.file), `.${Date.now()}-${process.pid}.tmp`);
    await writeFile(temp, JSON.stringify(data, null, 2), "utf-8");
    await rename(temp, this.file);
  }

  async remember(key: string, content: string, tags: string[]): Promise<{ entry: MemoryEntry; replaced: boolean }> {
    return this.serialize(async () => {
      const data = await this.load();
      const now = new Date().toISOString();
      const index = data.entries.findIndex(entry => entry.key.toLowerCase() === key.toLowerCase());

      if (index === -1 && data.entries.length >= this.maxEntries) {
        throw new MemoryLimitError(
          `Memory is full (${this.maxEntries} entries). Use forget to remove something first — ` +
            `entries are not evicted automatically, because they are the user's notes.`,
        );
      }

      const existing = index === -1 ? undefined : data.entries[index];
      const entry: MemoryEntry = {
        key,
        content,
        tags,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      if (index === -1) data.entries.push(entry);
      else data.entries[index] = entry;

      await this.save(data);
      return { entry, replaced: index !== -1 };
    });
  }

  async forget(key: string): Promise<boolean> {
    return this.serialize(async () => {
      const data = await this.load();
      const before = data.entries.length;
      data.entries = data.entries.filter(entry => entry.key.toLowerCase() !== key.toLowerCase());
      if (data.entries.length === before) return false;
      await this.save(data);
      return true;
    });
  }

  async recall(query: string | undefined, tags: string[], limit: number): Promise<MemoryEntry[]> {
    const data = await this.load();
    const terms = (query ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter(term => term !== "");

    const filtered =
      tags.length === 0
        ? data.entries
        : data.entries.filter(entry => tags.some(tag => entry.tags.some(t => t.toLowerCase() === tag.toLowerCase())));

    if (terms.length === 0) {
      return [...filtered].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
    }

    return filtered
      .map(entry => {
        const key = entry.key.toLowerCase();
        const content = entry.content.toLowerCase();
        const tagText = entry.tags.join(" ").toLowerCase();
        // A hit in the key is worth more than one buried in the body.
        const score = terms.reduce(
          (sum, term) =>
            sum + (key.includes(term) ? 10 : 0) + (tagText.includes(term) ? 5 : 0) + (content.includes(term) ? 1 : 0),
          0,
        );
        return { entry, score };
      })
      .filter(scored => scored.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt))
      .slice(0, limit)
      .map(scored => scored.entry);
  }

  async count(): Promise<number> {
    return (await this.load()).entries.length;
  }
}

// One store per file for the lifetime of the plugin process, so the serialization above actually
// covers every call rather than just those from a single toolsProvider invocation.
const stores = new Map<string, MemoryStore>();

export function getMemoryStore(file: string, maxEntries: number): MemoryStore {
  let store = stores.get(file);
  if (store === undefined) {
    store = new MemoryStore(file, maxEntries);
    stores.set(file, store);
  }
  return store;
}
