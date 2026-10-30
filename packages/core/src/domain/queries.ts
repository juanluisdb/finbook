import { calculatedDecimal, DecimalMath } from "./decimal.js";
import { fail, type DomainError, type Result } from "./result.js";
import { replayEvents } from "./replay.js";
import type { FxStamp, Money, PriceStamp, Provenance } from "./schemas.js";
import { createInitialState, type BookState, type Hole } from "./state.js";
import type { BookSnapshot } from "./snapshot.js";
import { IsoDateSchema } from "./scalars.js";
import { MoneyValue } from "./money.js";

export type CashPosition = {
  account: string;
  currency: string;
  balance: Money;
  valueEur: Money | null;
  fxMark: MarkEvidence | null;
};

export type MarkEvidence = { asOf: string; source: string };

export type Position = {
  account: string;
  instrument: string;
  quantity: string;
  cost: Money;
  valueEur: Money | null;
  priceMark: MarkEvidence | null;
  fxMark: MarkEvidence | null;
};

export type PositionsResult = {
  asOf: string;
  positions: readonly Position[];
  cash: readonly CashPosition[];
  holes: readonly Hole[];
};

export type Breakdown = {
  key: string;
  valueEur: Money | null;
  weight: string | null;
};

export type WeightMap = Record<string, string | null>;

export type Glance = {
  asOf: string;
  totalEur: Money | null;
  contributedEur: Money;
  pnlEur: Money | null;
  holes: readonly Hole[];
  byPlatform: readonly Breakdown[];
  byAssetType: readonly Breakdown[];
  byCurrency: readonly Breakdown[];
  cash: readonly CashPosition[];
  positions: readonly Position[];
  weights: {
    byPlatform: WeightMap;
    byAssetType: WeightMap;
    byCurrency: WeightMap;
  };
};

type Valuation = {
  asOf: string;
  totalEur: Money | null;
  positions: readonly Position[];
  cash: readonly CashPosition[];
  holes: readonly Hole[];
  byPlatform: readonly Breakdown[];
  byAssetType: readonly Breakdown[];
  byCurrency: readonly Breakdown[];
};

type Bucket = {
  value: MoneyValue;
  complete: boolean;
};

type BucketMap = Map<string, Bucket>;

export function getHistory(
  snapshot: BookSnapshot,
  from: string,
  through: string,
): Result<readonly Glance[]> {
  const start = IsoDateSchema.safeParse(from);
  const end = IsoDateSchema.safeParse(through);
  if (!start.success || !end.success || start.data > end.data) {
    return fail(
      validationError("Invalid history interval.", "Use YYYY-MM-DD with from on or before to."),
    );
  }
  const earliest = snapshot.events.reduce<string | undefined>(
    (date, event) => (date === undefined || event.date < date ? event.date : date),
    undefined,
  );
  if (earliest === undefined || earliest > end.data) return { ok: true, data: [] };
  const rows: Glance[] = [];
  let date = start.data > earliest ? start.data : earliest;
  while (date <= end.data) {
    const glance = getGlance(snapshot, date);
    if (!glance.ok) return glance;
    rows.push(glance.data);
    if (date === end.data) break;
    date = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  }
  return { ok: true, data: rows };
}

export function getPositions(snapshot: BookSnapshot, asOf: string): Result<PositionsResult> {
  const valuation = deriveValuation(snapshot, asOf);
  if (!valuation.ok) return fail(valuation.error);
  return {
    ok: true,
    data: {
      asOf: valuation.data.asOf,
      positions: valuation.data.positions,
      cash: valuation.data.cash,
      holes: valuation.data.holes,
    },
  };
}

export function getGlance(snapshot: BookSnapshot, asOf: string): Result<Glance> {
  const valuation = deriveValuation(snapshot, asOf);
  if (!valuation.ok) return fail(valuation.error);

  const contributedEur = valuation.data.dataState.contributedEur;
  const pnlEur =
    valuation.data.totalEur === null
      ? null
      : MoneyValue.from(valuation.data.totalEur)
          .subtract(MoneyValue.from(contributedEur))
          .toMoney();

  return {
    ok: true,
    data: {
      asOf: valuation.data.asOf,
      totalEur: valuation.data.totalEur,
      contributedEur,
      pnlEur,
      holes: valuation.data.holes,
      byPlatform: valuation.data.byPlatform,
      byAssetType: valuation.data.byAssetType,
      byCurrency: valuation.data.byCurrency,
      cash: valuation.data.cash,
      positions: valuation.data.positions,
      weights: {
        byPlatform: weightMap(valuation.data.byPlatform),
        byAssetType: weightMap(valuation.data.byAssetType),
        byCurrency: weightMap(valuation.data.byCurrency),
      },
    },
  };
}

type DerivedValuation = Valuation & { dataState: BookState };

function deriveValuation(snapshot: BookSnapshot, asOf: string): Result<DerivedValuation> {
  const parsedDate = IsoDateSchema.safeParse(asOf);
  if (!parsedDate.success) {
    return fail(validationError(`Invalid as-of date: ${asOf}.`, "Use YYYY-MM-DD."));
  }

  const replayed = replayEvents(
    createInitialState(snapshot.accounts, snapshot.instruments),
    snapshot.events,
    parsedDate.data,
  );
  if (!replayed.ok) return fail(replayed.error);

  const valuation = valueState(replayed.data, snapshot.prices, snapshot.fx, parsedDate.data);
  return { ok: true, data: { ...valuation, dataState: replayed.data } };
}

function valueState(
  state: BookState,
  prices: readonly PriceStamp[],
  fxStamps: readonly FxStamp[],
  asOf: string,
): Valuation {
  const holes: Hole[] = [];
  const positions: Position[] = [];
  const cash: CashPosition[] = [];
  const byPlatform = new Map<string, Bucket>();
  const byAssetType = new Map<string, Bucket>();
  const byCurrency = new Map<string, Bucket>();
  let total = MoneyValue.zero("EUR");
  let totalKnown = true;

  for (const account of state.accounts) {
    const accountCash = state.cash[account.id] ?? {};
    for (const [currency, balance] of Object.entries(accountCash)) {
      if (new DecimalMath(balance.amount).isZero()) continue;
      const marked = markCash(balance, currency, asOf, fxStamps);
      cash.push({
        account: account.id,
        currency,
        balance: { ...balance },
        valueEur: marked,
        fxMark: evidence(fxStampAt(currency, asOf, fxStamps)),
      });
      if (marked === null) {
        totalKnown = false;
        addHole(
          holes,
          valuationHole(`fx:${currency}/EUR`, currency, `Missing as-of FX stamp for ${currency}.`),
        );
      } else {
        total = total.add(MoneyValue.from(marked));
      }
      addBucket(byPlatform, account.platform, marked);
      addBucket(byCurrency, currency, marked);
    }

    const accountLots = state.lots[account.id] ?? {};
    for (const [instrumentId, lots] of Object.entries(accountLots)) {
      if (lots.length === 0) continue;
      const instrument = state.instruments.find((candidate) => candidate.id === instrumentId);
      if (instrument === undefined) continue;
      const quantity = lots.reduce(
        (sum, lot) => sum.plus(new DecimalMath(lot.quantity)),
        new DecimalMath(0),
      );
      const cost = lots.reduce(
        (sum, lot) => sum.add(MoneyValue.from(lot.cost)),
        MoneyValue.zero(instrument.quoteCurrency),
      );
      const selectedPrice = priceStampAt(instrument.id, asOf, prices);
      const price =
        selectedPrice?.price.currency === instrument.quoteCurrency ? selectedPrice : undefined;
      const marked =
        price === undefined ? null : markPosition(price.price, quantity.toFixed(), asOf, fxStamps);
      positions.push({
        account: account.id,
        instrument: instrument.id,
        quantity: quantity.toFixed(),
        cost: cost.toMoney(),
        valueEur: marked,
        priceMark: evidence(price),
        fxMark: evidence(fxStampAt(instrument.quoteCurrency, asOf, fxStamps)),
      });
      if (marked === null) {
        totalKnown = false;
        addHole(
          holes,
          price === undefined
            ? valuationHole(
                `price:${instrument.id}`,
                instrument.quoteCurrency,
                `Missing as-of price for ${instrument.id}.`,
              )
            : valuationHole(
                `fx:${instrument.quoteCurrency}/EUR`,
                instrument.quoteCurrency,
                `Missing as-of FX stamp for ${instrument.quoteCurrency}.`,
              ),
        );
      } else {
        total = total.add(MoneyValue.from(marked));
      }
      addBucket(byPlatform, account.platform, marked);
      addBucket(byAssetType, instrument.type, marked);
      addBucket(byCurrency, instrument.quoteCurrency, marked);
    }
  }

  const totalEur = totalKnown ? total.toMoney() : null;
  return {
    asOf,
    totalEur,
    positions,
    cash,
    holes,
    byPlatform: breakdowns(byPlatform, totalEur),
    byAssetType: breakdowns(byAssetType, totalEur),
    byCurrency: breakdowns(byCurrency, totalEur),
  };
}

function markCash(
  balance: Money,
  currency: string,
  asOf: string,
  fxStamps: readonly FxStamp[],
): Money | null {
  const rate = fxRateAt(currency, asOf, fxStamps);
  return rate === undefined ? null : convertToEur(balance, rate);
}

function markPosition(
  price: Money,
  quantity: string,
  asOf: string,
  fxStamps: readonly FxStamp[],
): Money | null {
  const rate = fxRateAt(price.currency, asOf, fxStamps);
  if (rate === undefined) return null;
  const nativeValue = MoneyValue.from(price).multiply(quantity).toMoney();
  return convertToEur(nativeValue, rate);
}

function convertToEur(money: Money, rate: string): Money {
  return {
    amount: new DecimalMath(money.amount).times(new DecimalMath(rate)).toFixed(),
    currency: "EUR",
  };
}

export function priceStampAt(
  instrument: string,
  asOf: string,
  prices: readonly PriceStamp[],
): PriceStamp | undefined {
  let selectedStamp: PriceStamp | undefined;
  for (const stamp of prices) {
    if (stamp.instrument === instrument && stamp.asOf <= asOf && supersedes(stamp, selectedStamp)) {
      selectedStamp = stamp;
    }
  }
  return selectedStamp;
}

function fxRateAt(
  currency: string,
  asOf: string,
  fxStamps: readonly FxStamp[],
): string | undefined {
  if (currency === "EUR") return "1";
  return fxStampAt(currency, asOf, fxStamps)?.rate;
}

export function fxStampAt(
  currency: string,
  asOf: string,
  fxStamps: readonly FxStamp[],
): FxStamp | undefined {
  const pair = `${currency}/EUR`;
  let selected: FxStamp | undefined;
  for (const stamp of fxStamps) {
    if (stamp.pair === pair && stamp.asOf <= asOf && supersedes(stamp, selected)) {
      selected = stamp;
    }
  }
  return selected;
}

function supersedes(
  candidate: { asOf: string; provenance: Provenance },
  selected: { asOf: string; provenance: Provenance } | undefined,
): boolean {
  if (selected === undefined || candidate.asOf > selected.asOf) return true;
  if (candidate.asOf < selected.asOf) return false;
  return candidate.provenance.kind === "manual" || selected.provenance.kind !== "manual";
}

function evidence(stamp: PriceStamp | FxStamp | undefined): MarkEvidence | null {
  if (stamp === undefined) return null;
  return {
    asOf: stamp.asOf,
    source: stamp.provenance.kind === "manual" ? "manual" : stamp.provenance.source,
  };
}

function addBucket(map: BucketMap, key: string, value: Money | null): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, {
      value: value === null ? MoneyValue.zero("EUR") : MoneyValue.from(value),
      complete: value !== null,
    });
    return;
  }
  if (value === null) {
    existing.complete = false;
    return;
  }
  existing.value = existing.value.add(MoneyValue.from(value));
}

function breakdowns(map: BucketMap, total: Money | null): Breakdown[] {
  return [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, bucket]) => ({
      key,
      valueEur: bucket.complete ? bucket.value.toMoney() : null,
      weight: weight(bucket, total),
    }));
}

function weight(bucket: Bucket, total: Money | null): string | null {
  if (!bucket.complete || total === null) return null;
  const totalValue = MoneyValue.from(total);
  if (totalValue.isZero()) return "0";
  return calculatedDecimal(bucket.value.amount.dividedBy(totalValue.amount));
}

function weightMap(rows: readonly Breakdown[]): WeightMap {
  return Object.fromEntries(rows.map((row) => [row.key, row.weight]));
}

function addHole(holes: Hole[], hole: Hole): void {
  if (holes.some((existing) => existing.kind === hole.kind && existing.sourceId === hole.sourceId))
    return;
  holes.push(hole);
}

function valuationHole(sourceId: string, currency: string, message: string): Hole {
  return { sourceId, kind: "valuation", currency, message };
}

function validationError(message: string, hint: string): DomainError {
  return { type: "validation", message, hint };
}
