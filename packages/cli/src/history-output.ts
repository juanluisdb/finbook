import { MoneyValue, type Glance } from "@finbook/core";
import type { HistoryUpdateReport } from "@finbook/market-data";
import { formatRows } from "./output.js";

export function renderHistory(rows: readonly Glance[]): string {
  return formatRows(
    ["DATE", "VALUE (EUR)", "OBSERVATIONS USED / MISSING INPUT"],
    rows.map((row) => {
      const evidence = new Set<string>();
      for (const position of row.positions) {
        if (position.priceMark !== null)
          evidence.add(
            `${position.instrument} price ${position.priceMark.asOf} / ${position.priceMark.source}`,
          );
        if (position.fxMark !== null)
          evidence.add(
            `${position.cost.currency}/EUR ${position.fxMark.asOf} / ${position.fxMark.source}`,
          );
      }
      for (const cash of row.cash) {
        if (cash.fxMark !== null)
          evidence.add(`${cash.currency}/EUR ${cash.fxMark.asOf} / ${cash.fxMark.source}`);
      }
      for (const hole of row.holes) evidence.add(hole.message);
      return [
        row.asOf,
        row.totalEur === null
          ? "unknown"
          : `${MoneyValue.from(row.totalEur).amount.toFixed(2)} EUR`,
        [...evidence].join("; ") || "EUR cash",
      ];
    }),
  );
}

export function renderHistoryUpdate(report: HistoryUpdateReport): string {
  const lines = [
    `History: checked ${report.checked.length} ranges; reused ${report.reused.length}; checked empty ${report.empty.length}.`,
    `Saved: ${report.saved.prices} prices, ${report.saved.fx} FX observations.`,
  ];
  for (const conflict of report.conflicts)
    lines.push(
      `${conflict.subject} ${conflict.asOf}: kept manual ${conflict.manual} ${conflict.currency}; fetched ${conflict.fetched} ${conflict.currency}.`,
    );
  for (const failure of report.failures)
    lines.push(
      `${failure.kind} ${failure.subject} ${failure.from} to ${failure.through} via ${failure.provider}: ${failure.error.kind}: ${failure.error.message}`,
    );
  return lines.join("\n");
}
