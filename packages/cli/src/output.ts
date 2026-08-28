import type { DomainError, Money } from "@finbook/core";

export function writeSuccess<T>(data: T, json: boolean, human: string): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
    return;
  }
  process.stdout.write(`${human}\n`);
}

export function writeError(error: DomainError, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: false, error })}\n`);
    return;
  }
  process.stderr.write(`error: ${error.message}\nhint: ${error.hint}\n`);
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
