import Coingecko from "@coingecko/coingecko-typescript";
import { IsoDateSchema, MoneyValue } from "@finbook/core";
import { z } from "zod";
import { createRetryingFetch } from "./http.js";
import {
  type EurRateNeed,
  type EurRateOutcome,
  type FxNeed,
  type FxOutcome,
  type FxSource,
  type HistoricalEurRateSource,
  type PriceNeed,
  type PriceOutcome,
  type PriceSource,
  type ProviderFailure,
} from "./contracts.js";

const CoinGeckoHistorySchema = z
  .object({
    prices: z.array(z.tuple([z.number().finite(), z.number().finite().positive()])),
  })
  .passthrough();
const SnapshotSchema = z
  .object({
    id: z.string(),
    market_data: z
      .object({ current_price: z.record(z.string(), z.number().finite().positive()) })
      .passthrough(),
  })
  .passthrough();

export type CoinGeckoHistoryPoint = { timestamp: number; price: number };
export type CoinGeckoGateway = {
  snapshotFor(
    id: string,
    currency: string,
    asOf: string,
  ): Promise<CoinGeckoHistoryPoint | undefined>;
  historyFor(id: string, currency: string, asOf: string): Promise<readonly CoinGeckoHistoryPoint[]>;
};
export type CoinGeckoSourceOptions = {
  gateway?: CoinGeckoGateway;
  demoApiKey?: string | undefined;
  fetchImplementation?: typeof fetch;
  now?: () => Date;
};

export class CoinGeckoSource implements PriceSource, FxSource, HistoricalEurRateSource {
  readonly id = "coingecko" as const;
  private readonly gateway: CoinGeckoGateway;
  private readonly now: () => Date;

  constructor(options: CoinGeckoSourceOptions = {}) {
    this.gateway = options.gateway ?? createCoinGeckoGateway(options);
    this.now = options.now ?? (() => new Date());
  }

  async fetchPrices(needs: readonly PriceNeed[]): Promise<readonly PriceOutcome[]> {
    return Promise.all(
      needs.map(async (need) => {
        const snapshot = await this.snapshot(
          need.identifier,
          need.instrument.quoteCurrency,
          need.asOf,
        );
        if (!snapshot.ok) return { need, ok: false, error: snapshot.error };
        return {
          need,
          ok: true,
          data: {
            instrument: need.instrument.id,
            price: {
              amount: plainAmount(snapshot.price, need.instrument.quoteCurrency),
              currency: need.instrument.quoteCurrency,
            },
            asOf: need.asOf,
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

  async fetchFxRates(needs: readonly FxNeed[]): Promise<readonly FxOutcome[]> {
    return Promise.all(
      needs.map(async (need) => {
        if (need.identifier === undefined)
          return {
            need,
            ok: false,
            error: {
              kind: "unsupported",
              message: "CoinGecko requires a currency binding.",
            },
          };
        const snapshot = await this.snapshot(need.identifier, "EUR", need.asOf);
        if (!snapshot.ok) return { need, ok: false, error: snapshot.error };
        return {
          need,
          ok: true,
          data: {
            pair: `${need.currency}/EUR`,
            rate: plainAmount(snapshot.price, "EUR"),
            asOf: need.asOf,
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

  private async snapshot(
    id: string,
    currency: string,
    asOf: string,
  ): Promise<{ ok: true; price: number } | { ok: false; error: ProviderFailure }> {
    let point: CoinGeckoHistoryPoint | undefined;
    try {
      point = await this.gateway.snapshotFor(id, currency.toLowerCase(), asOf);
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof z.ZodError
            ? { kind: "invalid-response", message: "CoinGecko returned an invalid daily snapshot." }
            : error instanceof Error
              ? coingeckoFailure(error, "CoinGecko snapshot request failed.")
              : { kind: "unavailable", message: "CoinGecko snapshot request failed." },
      };
    }
    if (point === undefined)
      return {
        ok: false,
        error: {
          kind: "not-found",
          message: `CoinGecko has no ${currency} snapshot for ${id} on ${asOf}.`,
        },
      };
    if (
      point.timestamp !== Date.parse(`${asOf}T00:00:00Z`) ||
      !Number.isFinite(point.price) ||
      point.price <= 0
    ) {
      return {
        ok: false,
        error: {
          kind: "invalid-response",
          message: "CoinGecko did not return the requested midnight UTC snapshot.",
        },
      };
    }
    return { ok: true, price: point.price };
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
          points = await this.gateway.historyFor(need.identifier, "eur", need.date);
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
  const client = new Coingecko({
    environment: "demo",
    demoAPIKey: options.demoApiKey,
    fetch: createRetryingFetch(options.fetchImplementation),
    maxRetries: 0,
    timeout: 10_000,
    logLevel: "off",
  });
  return {
    async snapshotFor(id, currency, asOf) {
      const response = await client.coins.history.get(id, { date: asOf, localization: false });
      const parsed = SnapshotSchema.extend({ id: z.literal(id) }).parse(response);
      const price = parsed.market_data.current_price[currency];
      return price === undefined
        ? undefined
        : { timestamp: Date.parse(`${asOf}T00:00:00Z`), price };
    },
    async historyFor(id, currency, asOf) {
      const end = new Date(`${asOf}T00:00:00.000Z`);
      const start = new Date(end.getTime() - 86_400_000);
      const response = await client.coins.marketChart.getRange(id, {
        from: start.toISOString(),
        to: new Date(end.getTime() + 86_400_000).toISOString(),
        vs_currency: currency,
        interval: "daily",
        precision: "full",
      });
      const parsed = CoinGeckoHistorySchema.safeParse(response);
      if (!parsed.success) return [];
      return parsed.data.prices.map(([timestamp, price]) => ({ timestamp, price }));
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
  return { kind: "unavailable", message: error.message || fallback };
}
