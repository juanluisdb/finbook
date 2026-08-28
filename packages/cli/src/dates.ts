import { IsoDateSchema } from "@finbook/core";

import { validationFailure } from "./errors.js";

export function currentDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function requireDate(value: string | undefined, flag: string, fallback: string): string {
  const candidate = value ?? fallback;
  const parsed = IsoDateSchema.safeParse(candidate);
  if (!parsed.success)
    throw validationFailure(`Invalid ${flag}: ${candidate}.`, `Use ${flag} YYYY-MM-DD.`);
  return parsed.data;
}
