import Coingecko from "@coingecko/coingecko-typescript";
import { IsoDateSchema, MoneyValue } from "@finbook/core";
import { z } from "zod";
import { createRetryingFetch } from "./http.js";
import {
  type EurRateNeed,
  type EurRateOutcome,
  type HistoricalEurRateSource,
  type ProviderFailure,
  type PriceHistorySource,
  type FxHistorySource,
  type PriceHistoryNeed,
  type PriceHistoryOutcome,
  type FxHistoryNeed,
  type FxHistoryOutcome,
  type HistoryWindow,
} from "./contracts.js";
import { shiftDate } from "./history-plan.js";

const CoinGeckoHistorySchema = z
  .object({
    prices: z.array(z.tuple([z.number().finite(), z.number().finite().positive()])),
  })
  .passthrough();
export type CoinGeckoHistoryPoint = { timestamp: number; price: number };
export type CoinGeckoGateway = {
  rangeFor(
    id: string,
    currency: string,
    from: string,
    through: string,
  ): Promise<readonly CoinGeckoHistoryPoint[]>;
};
export type CoinGeckoSourceOptions = {
  gateway?: CoinGeckoGateway;
  demoApiKey?: string | undefined;
  fetchImplementation?: typeof fetch;
  now?: () => Date;
};

export class CoinGeckoSource
  implements PriceHistorySource, FxHistorySource, HistoricalEurRateSource
{
  readonly id = "coingecko" as const;
  private readonly gateway: CoinGeckoGateway;
  private readonly now: () => Date;

  constructor(options: CoinGeckoSourceOptions = {}) {
    this.gateway = options.gateway ?? createCoinGeckoGateway(options);
    this.now = options.now ?? (() => new Date());
  }

  async fetchPriceHistory(need: PriceHistoryNeed): Promise<PriceHistoryOutcome> {
    if (need.instrument.type !== "crypto")
      return {
        ok: false,
        error: { kind: "unsupported", message: "CoinGecko history supports cryptoassets." },
      };
    const response = await this.closingHistory(
      need.identifier,
      need.instrument.quoteCurrency,
      need,
    );
    if (!response.ok) return response;
    return {
      ok: true,
      data: response.points.map((point) => ({
        instrument: need.instrument.id,
        asOf: point.date,
        price: {
          amount: plainAmount(point.price, need.instrument.quoteCurrency),
          currency: need.instrument.quoteCurrency,
        },
        provenance: { kind: "fetched", source: this.id, retrievedAt: this.now().toISOString() },
      })),
    };
  }

  async fetchFxHistory(needs: readonly FxHistoryNeed[]): Promise<readonly FxHistoryOutcome[]> {
    return Promise.all(
      needs.map(async (need): Promise<FxHistoryOutcome> => {
        if (need.identifier === undefined)
          return {
            need,
            ok: false,
            error: { kind: "unsupported", message: "CoinGecko requires a currency binding." },
          };
        const response = await this.closingHistory(need.identifier, "EUR", need);
        if (!response.ok) return { need, ...response };
        return {
          need,
          ok: true,
          data: response.points.map((point) => ({
            pair: `${need.currency}/EUR`,
            rate: plainAmount(point.price, "EUR"),
            asOf: point.date,
            provenance: { kind: "fetched", source: this.id, retrievedAt: this.now().toISOString() },
          })),
        };
      }),
    );
  }

  private async closingHistory(
    id: string,
    currency: string,
    window: HistoryWindow,
  ): Promise<
    { ok: true; points: { date: string; price: number }[] } | { ok: false; error: ProviderFailure }
  > {
    const day = 86_400_000;
    const availableFrom = new Date(Math.ceil((this.now().getTime() - 365 * day) / day) * day)
      .toISOString()
      .slice(0, 10);
    const requestedFrom =
      window.sourceFrom === undefined ? availableFrom : shiftDate(window.sourceFrom, 1);
    const from = requestedFrom < availableFrom ? availableFrom : requestedFrom;
    const through = shiftDate(window.through, 1);
    if (from > through) return { ok: true, points: [] };
    let points: readonly CoinGeckoHistoryPoint[];
    try {
      points = await this.gateway.rangeFor(id, currency.toLowerCase(), from, through);
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof z.ZodError
            ? { kind: "invalid-response", message: "CoinGecko returned invalid daily history." }
            : error instanceof Error
              ? coingeckoFailure(error, "CoinGecko history request failed.")
              : { kind: "unavailable", message: "CoinGecko history request failed." },
      };
    }
    const selected: { date: string; price: number }[] = [];
    const closingBoundary = Date.parse(`${through}T00:00:00Z`);
    for (const point of points) {
      if (!Number.isFinite(point.timestamp) || !Number.isFinite(point.price) || point.price <= 0)
        return {
          ok: false,
          error: { kind: "invalid-response", message: "CoinGecko returned invalid daily history." },
        };
      if (point.timestamp > closingBoundary) continue;
      if (point.timestamp % day !== 0)
        return {
          ok: false,
          error: {
            kind: "invalid-response",
            message: "CoinGecko returned a non-midnight daily price.",
          },
        };
      const date = dateOnly(new Date(point.timestamp));
      if (date === undefined)
        return {
          ok: false,
          error: {
            kind: "invalid-response",
            message: "CoinGecko returned an invalid observation date.",
          },
        };
      if (date < from) continue;
      selected.push({ date: shiftDate(date, -1), price: point.price });
    }
    return { ok: true, points: selected };
  }

  async fetchHistoricalEurRates(needs: readonly EurRateNeed[]): Promise<readonly EurRateOutcome[]> {
    return Promise.all(
      needs.map(async (need) => {
        if (need.identifier === undefined) {
          return {
            need,
            ok: false,
            error: { kind: "unsupported", message: "CoinGecko requires a coin ID binding." },
          };
        }
        let points: readonly CoinGeckoHistoryPoint[];
        try {
          points = await this.gateway.rangeFor(
            need.identifier,
            "eur",
            shiftDate(need.date, -1),
            shiftDate(need.date, 1),
          );
        } catch (error) {
          return {
            need,
            ok: false,
            error:
              error instanceof Error
                ? coingeckoFailure(error, "CoinGecko historical request failed.")
                : { kind: "unavailable", message: "CoinGecko historical request failed." },
          };
        }
        const selected = latestPoint(points, need.date);
        if (selected === undefined) {
          return {
            need,
            ok: false,
            error: {
              kind: "not-found",
              message: `CoinGecko returned no history for ${need.identifier}.`,
            },
          };
        }
        const effectiveDate = dateOnly(new Date(selected.timestamp));
        if (
          effectiveDate === undefined ||
          !Number.isFinite(selected.price) ||
          selected.price <= 0
        ) {
          return {
            need,
            ok: false,
            error: {
              kind: "invalid-response",
              message: `CoinGecko returned invalid history for ${need.identifier}.`,
            },
          };
        }
        return {
          need,
          ok: true,
          data: {
            rate: plainAmount(selected.price, "EUR"),
            effectiveDate,
            provenance: {
              kind: "fetched",
              source: "coingecko",
              retrievedAt: this.now().toISOString(),
            },
          },
        };
      }),
    );
  }
}

function createCoinGeckoGateway(options: CoinGeckoSourceOptions): CoinGeckoGateway {
  const demoApiKey = options.demoApiKey?.trim() || null;
  const client = new Coingecko({
    environment: "demo",
    demoAPIKey: demoApiKey,
    proAPIKey: null,
    defaultHeaders: {
      "x-cg-pro-api-key": null,
      "x-cg-demo-api-key": demoApiKey === null ? null : undefined,
    },
    fetch: createRetryingFetch(options.fetchImplementation),
    maxRetries: 0,
    timeout: 10_000,
    logLevel: "off",
  });
  return {
    async rangeFor(id, currency, from, through) {
      const response = await client.coins.marketChart.getRange(id, {
        from,
        to: through,
        vs_currency: currency,
        interval: "daily",
        precision: "full",
      });
      const parsed = CoinGeckoHistorySchema.parse(response);
      return parsed.prices.map(([timestamp, price]) => ({ timestamp, price }));
    },
  };
}

function latestPoint(
  points: readonly CoinGeckoHistoryPoint[],
  asOf: string,
): CoinGeckoHistoryPoint | undefined {
  let selected: CoinGeckoHistoryPoint | undefined;
  for (const point of points) {
    const date = dateOnly(new Date(point.timestamp));
    if (date === undefined || date > asOf) continue;
    if (selected === undefined || point.timestamp > selected.timestamp) selected = point;
  }
  return selected;
}

function plainAmount(value: number, currency: string): string {
  return MoneyValue.from({ amount: String(value), currency }).toMoney().amount;
}

function dateOnly(value: Date): string | undefined {
  if (!Number.isFinite(value.getTime())) return undefined;
  const result = IsoDateSchema.safeParse(value.toISOString().slice(0, 10));
  return result.success ? result.data : undefined;
}

function coingeckoFailure(error: Error, fallback: string): ProviderFailure {
  if (error instanceof z.ZodError)
    return { kind: "invalid-response", message: "CoinGecko returned invalid history." };
  if (error instanceof Coingecko.APIError) {
    const status = error.status;
    if (status === 401 || status === 403) {
      return {
        kind: "unauthorized",
        status,
        message: `CoinGecko rejected the request with HTTP ${status}.`,
      };
    }
    if (status === 404)
      return { kind: "not-found", status, message: "CoinGecko resource was not found." };
    if (status === 429)
      return { kind: "rate-limited", status, message: "CoinGecko rate-limited the request." };
    if (status !== undefined && status >= 500) {
      return { kind: "unavailable", status, message: `CoinGecko returned HTTP ${status}.` };
    }
    return {
      kind: "invalid-response",
      status,
      message: `CoinGecko returned HTTP ${status ?? "unknown"}.`,
    };
  }
  return { kind: "unavailable", message: fallback };
}
