import { IsoDateSchema } from "@finbook/core";

import { validationFailure } from "./errors.js";

export function currentDate(now: Date, timeZone: string): string {
  const formatOptions: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  };
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
  return parseDate(value ?? fallback, flag);
}

export function parseDate(value: string, flag: string): string {
  const parsed = IsoDateSchema.safeParse(value);
  if (!parsed.success)
    throw validationFailure(`Invalid ${flag}: ${value}.`, `Use ${flag} YYYY-MM-DD.`);
  return parsed.data;
}
