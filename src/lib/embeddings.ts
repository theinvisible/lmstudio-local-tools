import { LMStudioClient } from "@lmstudio/sdk";

/**
 * Thin wrapper around LM Studio's embedding models, used to make `recall` find notes by meaning
 * rather than by substring.
 *
 * Every path here is allowed to fail: no embedding model loaded, backend unreachable, model
 * unloaded mid-session. Callers fall back to keyword scoring, so this must never throw at them —
 * it returns null instead, together with a reason they can show the user.
 */

export interface EmbedderStatus {
  available: boolean;
  model?: string;
  reason?: string;
}

let clientPromise: Promise<LMStudioClient> | null = null;
let handleCache: { key: string; handle: { embed(input: string[]): Promise<{ embedding: number[] }[]> } } | null = null;
let lastFailure: string | undefined;

function getClient(): Promise<LMStudioClient> {
  // The SDK discovers the running LM Studio backend on its own; no server needs to be started.
  clientPromise ??= Promise.resolve(new LMStudioClient());
  return clientPromise;
}

async function getHandle(preferredModel: string): Promise<typeof handleCache> {
  const key = preferredModel;
  if (handleCache?.key === key) return handleCache;

  const client = await getClient();

  if (preferredModel.trim() !== "") {
    const handle = await client.embedding.model(preferredModel);
    handleCache = { key, handle: handle as unknown as NonNullable<typeof handleCache>["handle"] };
    return handleCache;
  }

  // No model configured: use whatever embedding model is already loaded, so recall never triggers
  // a surprise multi-gigabyte load in the background.
  const loaded = await client.embedding.listLoaded();
  const first = loaded[0];
  if (first === undefined) {
    lastFailure = "no embedding model is loaded in LM Studio";
    return null;
  }
  const handle = await client.embedding.model(first.identifier);
  handleCache = { key, handle: handle as unknown as NonNullable<typeof handleCache>["handle"] };
  return handleCache;
}

/** Returns one vector per input, or null when embeddings are unavailable for any reason. */
export async function embed(
  texts: string[],
  preferredModel: string,
): Promise<{ vectors: number[][]; model: string } | null> {
  if (texts.length === 0) return { vectors: [], model: "" };

  try {
    const cached = await getHandle(preferredModel);
    if (cached === null) return null;

    const results = await cached.handle.embed(texts);
    return {
      // Four decimals keep the memory file small without measurably hurting cosine similarity.
      vectors: results.map(result => result.embedding.map(value => Math.round(value * 10_000) / 10_000)),
      model: cached.key === "" ? "auto" : cached.key,
    };
  } catch (error) {
    lastFailure = (error as Error).message;
    handleCache = null; // the model may have been unloaded; re-resolve next time
    return null;
  }
}

export function lastEmbeddingFailure(): string | undefined {
  return lastFailure;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Used by the smoke test to force the fallback path. */
export function resetEmbedder(): void {
  clientPromise = null;
  handleCache = null;
  lastFailure = undefined;
}
