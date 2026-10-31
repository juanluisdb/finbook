import {
  MoneyValue,
  type Account,
  type Breakdown,
  type Event,
  type FxStamp,
  type Glance,
  type Hole,
  type Money,
  type Instrument,
  type PositionsResult,
  type PriceStamp,
} from "@finbook/core";

import type { DoctorReport } from "./doctor.js";
import { formatMoney, formatRows } from "./output.js";

export function renderDoctor(report: DoctorReport): string {
  return [
    formatRows(
      ["FIELD", "VALUE"],
      [
        ["status", report.status],
        [
          "schema version",
          report.schemaVersion === null ? "not initialized" : String(report.schemaVersion),
        ],
        ["time zone", report.timeZone ?? "unavailable"],
        ["events", String(report.eventCount)],
        ["holes", String(report.holeCount)],
        ["data path", report.dataPath],
      ],
    ),
    "",
    "checks",
    formatRows(
      ["CHECK", "STATUS", "DETAIL"],
      report.checks.map((check) => [
        check.id,
        check.status,
        check.hint === undefined ? check.message : `${check.message} ${check.hint}`,
      ]),
    ),
  ].join("\n");
}

export function renderAccounts(accounts: readonly Account[]): string {
  return formatRows(
    ["ID", "NAME", "PLATFORM", "COUNTRY", "CUSTODIAL"],
    accounts.map((account) => [
      account.id,
      account.name,
      account.platform,
      account.country,
      account.custodial,
    ]),
  );
}

export function renderInstruments(instruments: readonly Instrument[]): string {
  return formatRows(
    ["ID", "NAME", "TYPE", "QUOTE", "ISIN"],
    instruments.map((instrument) => [
      instrument.id,
      instrument.name,
      instrument.type,
      instrument.quoteCurrency,
      instrument.isin ?? "",
    ]),
  );
}

export function renderEvents(events: readonly Event[]): string {
  return formatRows(
    ["DATE", "TYPE", "ID", "SUMMARY"],
    events.map((event) => [event.date, event.type, event.id, eventSummary(event)]),
  );
}

export function renderPrices(prices: readonly PriceStamp[]): string {
  return formatRows(
    ["AS OF", "INSTRUMENT", "PRICE"],
    prices.map((stamp) => [stamp.asOf, stamp.instrument, formatMoney(stamp.price)]),
  );
}

export function renderFx(stamps: readonly FxStamp[]): string {
  return formatRows(
    ["AS OF", "PAIR", "RATE"],
    stamps.map((stamp) => [stamp.asOf, stamp.pair, stamp.rate]),
  );
}

export function renderGlance(glance: Glance): string {
  const lines = [
    `as of: ${glance.asOf}`,
    `total: ${formatValuation(glance.totalEur)}`,
    `contributed: ${formatValuation(glance.contributedEur)}`,
    `value minus contributions: ${formatValuation(glance.pnlEur)}`,
    `missing inputs: ${String(glance.holes.length)}`,
    "",
    "valuation evidence (economic dates)",
    renderValuationEvidence(glance.positions, glance.cash),
    "",
    "by platform",
    renderBreakdowns(glance.byPlatform),
    "",
    "by asset type",
    renderBreakdowns(glance.byAssetType),
    "",
    "by currency",
    renderBreakdowns(glance.byCurrency),
  ];
  return appendHoles(lines, glance.holes, glance.asOf);
}

export function renderPositions(result: PositionsResult): string {
  const lines = [
    `as of: ${result.asOf}`,
    "positions",
    formatRows(
      ["ACCOUNT", "INSTRUMENT", "QUANTITY", "COST", "VALUE EUR", "PRICE MARK", "FX MARK"],
      result.positions.map((position) => [
        position.account,
        position.instrument,
        position.quantity,
        formatMoney(position.cost),
        formatValuation(position.valueEur),
        formatEvidence(position.priceMark),
        formatEvidence(position.fxMark),
      ]),
    ),
    "",
    "cash",
    formatRows(
      ["ACCOUNT", "CURRENCY", "BALANCE", "VALUE EUR", "FX MARK"],
      result.cash.map((entry) => [
        entry.account,
        entry.currency,
        formatMoney(entry.balance),
        formatValuation(entry.valueEur),
        formatEvidence(entry.fxMark),
      ]),
    ),
  ];
  return appendHoles(lines, result.holes, result.asOf);
}

function formatEvidence(mark: PositionsResult["positions"][number]["priceMark"]): string {
  return mark === null ? "—" : `${mark.asOf} / ${mark.source}`;
}

function renderValuationEvidence(
  positions: PositionsResult["positions"],
  cash: PositionsResult["cash"],
): string {
  const rows = new Map<string, readonly string[]>();
  for (const position of positions) {
    rows.set(`price:${position.instrument}`, [
      position.instrument,
      formatEvidence(position.priceMark),
    ]);
    if (position.cost.currency !== "EUR") {
      rows.set(`fx:${position.cost.currency}`, [
        `${position.cost.currency}/EUR`,
        formatEvidence(position.fxMark),
      ]);
    }
  }
  for (const entry of cash) {
    if (entry.currency !== "EUR")
      rows.set(`fx:${entry.currency}`, [`${entry.currency}/EUR`, formatEvidence(entry.fxMark)]);
  }
  return formatRows(["SUBJECT", "OBSERVATION / SOURCE"], [...rows.values()]);
}

export function renderHoles(holes: readonly Hole[], asOf: string): string {
  if (holes.length === 0) return "";
  const lines = ["", "missing data"];
  for (const hole of holes) {
    const price = prefixedValue(hole.sourceId, "price:");
    if (price !== undefined) {
      lines.push(
        `- price ${price} in ${hole.currency} as of ${asOf}`,
        `  add: finbook price set --instrument ${price} --amount <decimal> --currency ${hole.currency} --as-of ${asOf}`,
        "  or:  finbook update",
      );
      continue;
    }

    const pair = prefixedValue(hole.sourceId, "fx:");
    if (pair !== undefined) {
      lines.push(
        `- FX ${pair} as of ${asOf}`,
        `  add: finbook fx set --pair ${pair} --rate <decimal> --as-of ${asOf}`,
        "  or:  finbook update",
      );
      continue;
    }

    lines.push(`- ${hole.message}`, "  or: finbook update");
  }
  return lines.join("\n");
}

function eventSummary(event: Event): string {
  switch (event.type) {
    case "deposit":
      return `+${formatMoney(event.amount)} → ${event.account}`;
    case "withdrawal":
      return `-${formatMoney(event.amount)} ← ${event.account}`;
    case "transfer":
      return `${formatMoney(event.amount)} ${event.from} → ${event.to}`;
    case "fx":
      return `${event.account}: ${formatMoney(event.from)} → ${formatMoney(event.to)}${moneyFeeSummary(event.fee)}`;
    case "buy":
    case "sell":
      return `${event.account}: ${event.type} ${event.qty} ${event.instrument} @ ${formatMoney(event.price)}; gross ${event.grossAmount} ${event.price.currency}${tradeFeeSummary(event)}`;
    case "dividend":
      return `${event.account}: ${event.instrument} gross ${formatMoney(event.gross)}; net ${formatMoney(netIncome(event))}`;
    case "interest":
      return `${event.account}: gross ${formatMoney(event.gross)}; net ${formatMoney(netIncome(event))}`;
    case "fee":
      return `${event.account}: -${formatMoney(event.amount)}`;
  }
}

function moneyFeeSummary(fee: Extract<Event, { type: "fx" }>["fee"]): string {
  return fee === undefined ? "" : `; fee ${formatMoney(fee)}`;
}

function tradeFeeSummary(event: Extract<Event, { type: "buy" | "sell" }>): string {
  if (event.fee === undefined) return "";
  return event.fee.kind === "quote"
    ? `; fee ${event.fee.amount} ${event.price.currency} from quote cash`
    : `; fee ${event.fee.quantity} ${event.instrument} from instrument`;
}

function netIncome(event: Extract<Event, { type: "dividend" | "interest" }>) {
  let net = MoneyValue.from(event.gross);
  if (event.withholdingForeign !== undefined) {
    net = net.subtract(MoneyValue.from(event.withholdingForeign));
  }
  if (event.withholdingDomestic !== undefined) {
    net = net.subtract(MoneyValue.from(event.withholdingDomestic));
  }
  return net.toMoney();
}

function renderBreakdowns(rows: readonly Breakdown[]): string {
  return formatRows(
    ["KEY", "VALUE EUR", "WEIGHT"],
    rows.map((row) => [row.key, formatValuation(row.valueEur), row.weight ?? "unknown"]),
  );
}

function appendHoles(lines: readonly string[], holes: readonly Hole[], asOf: string): string {
  const rendered = renderHoles(holes, asOf);
  return (rendered === "" ? lines : [...lines, rendered]).join("\n");
}

function prefixedValue(value: string, prefix: string): string | undefined {
  return value.startsWith(prefix) ? value.slice(prefix.length) : undefined;
}

function formatValuation(money: Money | null): string {
  return money === null
    ? "unknown"
    : `${MoneyValue.from(money).amount.toFixed(2)} ${money.currency}`;
}
