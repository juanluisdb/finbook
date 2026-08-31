import YahooFinance from "yahoo-finance2";
import { IsoDateSchema, MoneyValue, type Instrument } from "@finbook/core";

import { createRetryingFetch } from "./http.js";
import {
  type PriceNeed,
  type PriceOutcome,
  type PriceSource,
  type ProviderFailure,
} from "./contracts.js";

export type YahooQuote = {
  symbol: string;
  currency?: string;
  regularMarketPrice?: number;
  regularMarketTime?: Date;
};

export type YahooHistoryPoint = {
  date: Date;
  close: number | null;
};

export type YahooChartWindow = {
  from: string;
  to: string;
};

export type YahooGateway = {
  quote(symbols: readonly string[]): Promise<readonly YahooQuote[]>;
  chart(symbol: string, window: YahooChartWindow): Promise<readonly YahooHistoryPoint[]>;
};

export type YahooSourceOptions = {
  gateway?: YahooGateway;
  fetchImplementation?: typeof fetch;
  now?: () => Date;
};

export class YahooSource implements PriceSource {
  readonly id = "yahoo" as const;
  private readonly gateway: YahooGateway;
  private readonly now: () => Date;

  constructor(options: YahooSourceOptions = {}) {
    this.gateway = options.gateway ?? createYahooGateway(options.fetchImplementation);
    this.now = options.now ?? (() => new Date());
  }

  async fetchPrices(needs: readonly PriceNeed[]): Promise<readonly PriceOutcome[]> {
    const outcomes = new Map<string, PriceOutcome>();
    const current = needs.filter((need) => need.mode === "latest");
    const historical = needs.filter((need) => need.mode === "historical");

    if (current.length > 0) await this.fetchCurrent(current, outcomes);
    await Promise.all(historical.map(async (need) => this.fetchHistorical(need, outcomes)));

    return needs.map(
      (need) =>
        outcomes.get(priceNeedKey(need)) ?? {
          need,
          ok: false,
          error: { kind: "invalid-response", message: "Yahoo omitted a requested price." },
        },
    );
  }

  private async fetchCurrent(
    needs: readonly PriceNeed[],
    outcomes: Map<string, PriceOutcome>,
  ): Promise<void> {
    let quotes: readonly YahooQuote[];
    try {
      quotes = await this.gateway.quote(needs.map((need) => need.identifier));
    } catch (error) {
      const failure: ProviderFailure = {
        kind: "unavailable",
        message: error instanceof Error ? error.message : "Yahoo quote request failed.",
      };
      for (const need of needs)
        outcomes.set(priceNeedKey(need), { need, ok: false, error: failure });
      return;
    }

    for (const need of needs) {
      const quote = quotes.find((candidate) => candidate.symbol === need.identifier);
      if (quote === undefined) {
        outcomes.set(priceNeedKey(need), {
          need,
          ok: false,
          error: { kind: "not-found", message: `Yahoo returned no quote for ${need.identifier}.` },
        });
        continue;
      }
      outcomes.set(priceNeedKey(need), normalizeQuote(need, quote, this.now()));
    }
  }

  private async fetchHistorical(
    need: PriceNeed,
    outcomes: Map<string, PriceOutcome>,
  ): Promise<void> {
    let points: readonly YahooHistoryPoint[];
    try {
      points = await this.gateway.chart(need.identifier, yahooChartWindow(need.asOf));
    } catch (error) {
      outcomes.set(priceNeedKey(need), {
        need,
        ok: false,
        error: {
          kind: "unavailable",
          message: error instanceof Error ? error.message : "Yahoo historical request failed.",
        },
      });
      return;
    }
    let selected: YahooHistoryPoint | undefined;
    for (const point of points) {
      const date = dateOnly(point.date);
      if (date === undefined || date > need.asOf || point.close === null) continue;
      if (!Number.isFinite(point.close) || point.close <= 0) continue;
      const selectedDate = selected === undefined ? undefined : dateOnly(selected.date);
      if (selected === undefined || (selectedDate !== undefined && date > selectedDate)) {
        selected = point;
      }
    }
    if (selected === undefined) {
      outcomes.set(priceNeedKey(need), {
        need,
        ok: false,
        error: { kind: "not-found", message: `Yahoo returned no history for ${need.identifier}.` },
      });
      return;
    }
    const date = dateOnly(selected.date);
    if (date === undefined || selected.close === null) {
      outcomes.set(priceNeedKey(need), {
        need,
        ok: false,
        error: {
          kind: "invalid-response",
          message: `Yahoo returned invalid history for ${need.identifier}.`,
        },
      });
      return;
    }
    outcomes.set(priceNeedKey(need), {
      need,
      ok: true,
      data: {
        instrument: need.instrument.id,
        price: {
          amount: plainAmount(selected.close, need.instrument),
          currency: need.instrument.quoteCurrency,
        },
        asOf: date,
        provenance: {
          kind: "fetched",
          source: "yahoo",
          retrievedAt: this.now().toISOString(),
        },
      },
    });
  }
}

function createYahooGateway(fetchImplementation: typeof fetch = globalThis.fetch): YahooGateway {
  const client = new YahooFinance({
    fetch: createRetryingFetch(fetchImplementation),
    versionCheck: false,
    suppressNotices: ["yahooSurvey"],
    queue: { concurrency: 4 },
  });
  return {
    async quote(symbols) {
      const quotes = await client.quote([...symbols], {
        fields: ["symbol", "regularMarketPrice", "currency", "regularMarketTime"],
        return: "array",
      });
      return quotes.map((quote) => ({
        symbol: quote.symbol,
        currency: quote.currency,
        regularMarketPrice: quote.regularMarketPrice,
        regularMarketTime: quote.regularMarketTime,
      }));
    },
    async chart(symbol, window) {
      const start = new Date(window.from);
      const end = new Date(window.to);
      const chart = await client.chart(symbol, {
        period1: start,
        period2: end,
        interval: "1d",
        return: "array",
      });
      return chart.quotes.map((quote) => ({ date: quote.date, close: quote.close }));
    },
  };
}

function yahooChartWindow(asOf: string): YahooChartWindow {
  const end = new Date(`${asOf}T00:00:00.000Z`);
  const from = new Date(end.getTime() - 9 * 86_400_000);
  const to = new Date(end.getTime() + 86_400_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

function normalizeQuote(need: PriceNeed, quote: YahooQuote, now: Date): PriceOutcome {
  if (quote.currency !== need.instrument.quoteCurrency) {
    return {
      need,
      ok: false,
      error: {
        kind: "invalid-response",
        message: `Yahoo returned ${quote.currency ?? "no currency"} for ${need.instrument.quoteCurrency}.`,
      },
    };
  }
  if (
    quote.regularMarketPrice === undefined ||
    !Number.isFinite(quote.regularMarketPrice) ||
    quote.regularMarketPrice <= 0 ||
    quote.regularMarketTime === undefined
  ) {
    return {
      need,
      ok: false,
      error: {
        kind: "invalid-response",
        message: `Yahoo returned an incomplete quote for ${need.identifier}.`,
      },
    };
  }
  const asOf = dateOnly(quote.regularMarketTime);
  if (asOf === undefined) {
    return {
      need,
      ok: false,
      error: {
        kind: "invalid-response",
        message: `Yahoo returned an invalid quote date for ${need.identifier}.`,
      },
    };
  }
  return {
    need,
    ok: true,
    data: {
      instrument: need.instrument.id,
      price: {
        amount: plainAmount(quote.regularMarketPrice, need.instrument),
        currency: need.instrument.quoteCurrency,
      },
      asOf,
      provenance: { kind: "fetched", source: "yahoo", retrievedAt: now.toISOString() },
    },
  };
}

function plainAmount(value: number, instrument: Instrument): string {
  return MoneyValue.from({ amount: String(value), currency: instrument.quoteCurrency }).toMoney()
    .amount;
}

function dateOnly(value: Date): string | undefined {
  if (!Number.isFinite(value.getTime())) return undefined;
  const date = value.toISOString().slice(0, 10);
  return IsoDateSchema.safeParse(date).success ? date : undefined;
}

function priceNeedKey(need: PriceNeed): string {
  return `${need.instrument.id}:${need.asOf}:${need.mode}`;
}
