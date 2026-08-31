import { IsoDateSchema } from "@finbook/core";

import { validationFailure } from "./errors.js";

export function currentDate(now: Date = new Date(), timeZone?: string): string {
  const formatOptions: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  };
  if (timeZone !== undefined) formatOptions.timeZone = timeZone;
  const formatter = new Intl.DateTimeFormat("en-US", formatOptions);
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((part) => [part.type, part.value]),
  );
  const year = parts.year;
  const month = parts.month;
  const day = parts.day;
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error("Could not resolve the local calendar date.");
  }
  return `${year}-${month}-${day}`;
}

export function requireDate(value: string | undefined, flag: string, fallback: string): string {
  const candidate = value ?? fallback;
  const parsed = IsoDateSchema.safeParse(candidate);
  if (!parsed.success)
    throw validationFailure(`Invalid ${flag}: ${candidate}.`, `Use ${flag} YYYY-MM-DD.`);
  return parsed.data;
}
