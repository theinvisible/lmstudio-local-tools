import { tool } from "@lmstudio/sdk";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { resolveReadableFile } from "../lib/sandbox";
import { describeError, type ToolDeps } from "./../lib/shared";

const ALGORITHMS = ["md5", "sha1", "sha256", "sha512"] as const;

export function createHashTool(deps: ToolDeps) {
  return tool({
    name: "hash",
    description:
      "Compute a checksum of a text or of a file on disk (md5, sha1, sha256, sha512). Use it to " +
      "verify a download against a published checksum, or to check whether two files are identical.",
    parameters: {
      algorithm: z.enum(ALGORITHMS).describe("Hash algorithm."),
      text: z.string().optional().describe("Text to hash. Give either this or 'file'."),
      file: z.string().optional().describe("Path of a file to hash. Give either this or 'text'."),
    },
    implementation: async ({ algorithm, text, file }, { status, warn }) => {
      if ((text === undefined) === (file === undefined)) {
        return { error: "Give exactly one of 'text' or 'file'." };
      }

      try {
        const hash = createHash(algorithm);

        if (text !== undefined) {
          hash.update(text, "utf-8");
          return { algorithm, source: "text", length: text.length, hash: hash.digest("hex") };
        }

        status(`Hashing ${file} ...`);
        const target = await resolveReadableFile(file as string, deps);
        await pipeline(createReadStream(target.path), hash);

        status("Done");
        return { algorithm, source: "file", path: target.path, size: target.size, hash: hash.digest("hex") };
      } catch (error) {
        const message = describeError(error);
        warn(`hash: ${message}`);
        return { error: message };
      }
    },
  });
}
