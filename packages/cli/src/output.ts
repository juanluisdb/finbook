import type { DomainError, Money } from "@finbook/core";

import type { ExternalFailureDetails } from "./errors.js";

export function writeSuccess<T>(data: T, json: boolean, human: string): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
    return;
  }
  process.stdout.write(`${human}\n`);
}

export function writeError(
  error: DomainError,
  json: boolean,
  details?: ExternalFailureDetails,
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: false, error })}\n`);
    return;
  }
  const failures = details?.failures.map(formatPartialFailure) ?? [];
  const report = failures.length === 0 ? "" : `${failures.join("\n")}\n`;
  process.stderr.write(`error: ${error.message}\n${report}hint: ${error.hint}\n`);
}

export function formatMoney(money: Money | null): string {
  return money === null ? "unknown" : `${money.amount} ${money.currency}`;
}

export function formatRows(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  if (rows.length === 0) return "(empty)";
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const format = (row: readonly string[]): string =>
    row.map((value, column) => value.padEnd(widths[column] ?? value.length)).join("  ");
  return [
    format(headers),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map(format),
  ].join("\n");
}

function formatPartialFailure(failure: ExternalFailureDetails["failures"][number]): string {
  return `- ${failure.kind} ${failure.subject} via ${failure.provider}: ${failure.reason}: ${failure.message}`;
}
