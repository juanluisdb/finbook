import YahooFinance from "yahoo-finance2";
import { CurrencySchema, IsoDateSchema, TimeZoneSchema } from "@finbook/core";
import { z } from "zod";
import { createRetryingFetch } from "./http.js";
import {
  type PriceHistorySource,
  type PriceHistoryNeed,
  type PriceHistoryOutcome,
} from "./contracts.js";

export type YahooHistoryPoint = { date: Date; close: number | null };
export type YahooChartWindow = { from: string; to: string };
export type YahooChart = {
  currency: string;
  timeZone: string;
  quotes: readonly YahooHistoryPoint[];
};
export type YahooGateway = { chart(symbol: string, window: YahooChartWindow): Promise<YahooChart> };
export type YahooSourceOptions = {
  gateway?: YahooGateway;
  fetchImplementation?: typeof fetch;
  now?: () => Date;
};

const ChartSchema = z
  .object({
    meta: z
      .object({ currency: CurrencySchema, exchangeTimezoneName: TimeZoneSchema })
      .passthrough(),
    quotes: z.array(
      z.object({ date: z.coerce.date(), close: z.number().finite().nullable() }).passthrough(),
    ),
  })
  .passthrough();

export class YahooSource implements PriceHistorySource {
  readonly id = "yahoo" as const;
  private readonly gateway: YahooGateway;
  private readonly now: () => Date;

  constructor(options: YahooSourceOptions = {}) {
    this.gateway = options.gateway ?? createYahooGateway(options.fetchImplementation);
    this.now = options.now ?? (() => new Date());
  }

  async fetchPriceHistory(need: PriceHistoryNeed): Promise<PriceHistoryOutcome> {
    if (need.instrument.type !== "fund")
      return {
        ok: false,
        error: {
          kind: "unsupported",
          message:
            "Yahoo historical unit prices are supported only for funds; bind stocks to a raw-close source.",
        },
      };
    let chart: YahooChart;
    try {
      chart = await this.gateway.chart(need.identifier, {
        from: `${need.sourceFrom ?? "1970-01-01"}T00:00:00.000Z`,
        to: new Date(Date.parse(`${need.through}T00:00:00Z`) + 2 * 86_400_000).toISOString(),
      });
    } catch {
      return {
        ok: false,
        error: { kind: "unavailable", message: "Yahoo historical price request failed." },
      };
    }
    if (chart.currency !== need.instrument.quoteCurrency)
      return {
        ok: false,
        error: {
          kind: "invalid-response",
          message: "Yahoo historical quote currency does not match the instrument.",
        },
      };
    const tradingDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: chart.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const observations = [];
    for (const point of chart.quotes) {
      if (point.close === null) continue;
      if (!Number.isFinite(point.close) || point.close <= 0)
        return {
          ok: false,
          error: {
            kind: "invalid-response",
            message: "Yahoo returned an invalid historical close.",
          },
        };
      const values = Object.fromEntries(
        tradingDate.formatToParts(point.date).map((part) => [part.type, part.value]),
      );
      const date = IsoDateSchema.safeParse(`${values.year}-${values.month}-${values.day}`);
      if (!date.success)
        return {
          ok: false,
          error: { kind: "invalid-response", message: "Yahoo returned an invalid trading date." },
        };
      if (date.data > need.through) continue;
      observations.push({
        instrument: need.instrument.id,
        price: { amount: String(point.close), currency: chart.currency },
        asOf: date.data,
        provenance: {
          kind: "fetched" as const,
          source: this.id,
          retrievedAt: this.now().toISOString(),
        },
      });
    }
    return { ok: true, data: observations };
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
    async chart(symbol, window) {
      const response = await client.chart(symbol, {
        period1: new Date(window.from),
        period2: new Date(window.to),
        interval: "1d",
        return: "array",
      });
      const parsed = ChartSchema.parse(response);
      return {
        currency: parsed.meta.currency,
        timeZone: parsed.meta.exchangeTimezoneName,
        quotes: parsed.quotes,
      };
    },
  };
}
