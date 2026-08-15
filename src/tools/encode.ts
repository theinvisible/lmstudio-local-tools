import { tool } from "@lmstudio/sdk";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { describeError } from "./../lib/shared";

const OPERATIONS = [
  "base64_encode",
  "base64_decode",
  "base64url_encode",
  "base64url_decode",
  "url_encode",
  "url_decode",
  "hex_encode",
  "hex_decode",
  "jwt_decode",
  "uuid_v4",
] as const;

type Operation = (typeof OPERATIONS)[number];

function decodeJwtPart(part: string): unknown {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf-8")) as unknown;
}

function timestampFields(payload: unknown): Record<string, string> {
  if (typeof payload !== "object" || payload === null) return {};
  const out: Record<string, string> = {};
  for (const [field, label] of [
    ["exp", "expires_at"],
    ["iat", "issued_at"],
    ["nbf", "not_before"],
  ] as const) {
    const value = (payload as Record<string, unknown>)[field];
    if (typeof value === "number") out[label] = new Date(value * 1000).toISOString();
  }
  return out;
}

export function createEncodeTool() {
  return tool({
    name: "encode",
    description:
      "Convert text between encodings — base64, base64url, URL escaping, hex — decode a JWT to see " +
      "its header and payload, or generate a UUID. Handy for API tokens, config values and " +
      "debugging, without having to do it by hand.",
    parameters: {
      operation: z.enum(OPERATIONS).describe("What to do. 'uuid_v4' ignores the input."),
      input: z.string().optional().describe("The text to convert. Not needed for uuid_v4."),
    },
    implementation: async ({ operation, input }) => {
      const op = operation as Operation;
      if (op !== "uuid_v4" && (input === undefined || input === "")) {
        return { error: `Operation "${op}" needs an 'input'.` };
      }
      const value = input ?? "";

      try {
        switch (op) {
          case "uuid_v4":
            return { operation: op, result: randomUUID() };
          case "base64_encode":
            return { operation: op, result: Buffer.from(value, "utf-8").toString("base64") };
          case "base64_decode":
            return { operation: op, result: Buffer.from(value, "base64").toString("utf-8") };
          case "base64url_encode":
            return { operation: op, result: Buffer.from(value, "utf-8").toString("base64url") };
          case "base64url_decode":
            return { operation: op, result: Buffer.from(value, "base64url").toString("utf-8") };
          case "url_encode":
            return { operation: op, result: encodeURIComponent(value) };
          case "url_decode":
            return { operation: op, result: decodeURIComponent(value) };
          case "hex_encode":
            return { operation: op, result: Buffer.from(value, "utf-8").toString("hex") };
          case "hex_decode":
            return { operation: op, result: Buffer.from(value, "hex").toString("utf-8") };
          case "jwt_decode": {
            const parts = value.trim().split(".");
            if (parts.length < 2) return { operation: op, error: "Not a JWT — expected at least header.payload." };
            const payload = decodeJwtPart(parts[1] as string);
            return {
              operation: op,
              header: decodeJwtPart(parts[0] as string),
              payload,
              ...timestampFields(payload),
              signature_present: parts.length > 2 && parts[2] !== "",
              // Worth stating plainly: this only decodes. A forged token decodes just as cleanly.
              note: "The signature was NOT verified — decoding proves nothing about the token's validity.",
            };
          }
        }
      } catch (error) {
        return { operation: op, error: describeError(error) };
      }
    },
  });
}
