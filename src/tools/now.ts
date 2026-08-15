import { tool } from "@lmstudio/sdk";
import { z } from "zod";
import { describeError } from "./../lib/shared";

/** ISO-8601 week number, which neither Date nor Intl exposes directly. */
function isoWeek(date: Date): number {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.ceil(((target.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

function describeIn(date: Date, timeZone: string | undefined): Record<string, string> {
  const options: Intl.DateTimeFormatOptions = {
    dateStyle: "full",
    timeStyle: "long",
    ...(timeZone !== undefined ? { timeZone } : {}),
  };
  const resolved = new Intl.DateTimeFormat("de-DE", options).resolvedOptions();
  return {
    timezone: resolved.timeZone,
    formatted: new Intl.DateTimeFormat("de-DE", options).format(date),
    formatted_en: new Intl.DateTimeFormat("en-GB", options).format(date),
  };
}

export function createNowTool() {
  return tool({
    name: "now",
    description:
      "Get the current date and time — never guess it. Also converts a given timestamp between " +
      "time zones. Call this whenever the answer depends on today's date, on how long ago something " +
      "was, or on what time it is somewhere else.",
    parameters: {
      timezone: z
        .string()
        .optional()
        .describe("IANA time zone for the result, e.g. 'Europe/Vienna' or 'UTC'. Default: this machine's zone."),
      timestamp: z
        .string()
        .optional()
        .describe("Instead of 'now', use this instant: an ISO-8601 string or a Unix timestamp in seconds."),
      to_timezone: z.string().optional().describe("Additionally show the result in this second time zone."),
    },
    implementation: async ({ timezone, timestamp, to_timezone }) => {
      try {
        let date: Date;
        if (timestamp === undefined) {
          date = new Date();
        } else if (/^\d{9,13}$/.test(timestamp.trim())) {
          const value = Number(timestamp.trim());
          date = new Date(timestamp.trim().length > 10 ? value : value * 1000);
        } else {
          date = new Date(timestamp);
        }

        if (Number.isNaN(date.getTime())) {
          return { error: `Could not parse "${timestamp}" as a date. Use ISO-8601 or a Unix timestamp.` };
        }

        return {
          iso: date.toISOString(),
          unix_seconds: Math.floor(date.getTime() / 1000),
          weekday: new Intl.DateTimeFormat("en-GB", {
            weekday: "long",
            ...(timezone !== undefined ? { timeZone: timezone } : {}),
          }).format(date),
          iso_week: isoWeek(date),
          primary: describeIn(date, timezone),
          ...(to_timezone !== undefined ? { converted: describeIn(date, to_timezone) } : {}),
          is_current_time: timestamp === undefined,
        };
      } catch (error) {
        // An unknown IANA zone lands here as a RangeError from Intl.
        return { error: describeError(error) };
      }
    },
  });
}
