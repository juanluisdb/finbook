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

const CoinGeckoPriceItemSchema = z
  .record(z.string(), z.number().finite().positive().optional())
  .default({});
const CoinGeckoHistorySchema = z
  .object({
    prices: z.array(z.tuple([z.number().finite(), z.number().finite().positive()])),
  })
  .passthrough();

export type CoinGeckoPrice = {
  id: string;
  price: number;
  asOf?: Date;
};

export type CoinGeckoHistoryPoint = {
  timestamp: number;
  price: number;
};

export type CoinGeckoGateway = {
  pricesFor(ids: readonly string[], currency: string): Promise<readonly CoinGeckoPrice[]>;
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
          error: { kind: "invalid-response", message: "CoinGecko omitted a requested price." },
        },
    );
  }

  async fetchFxRates(needs: readonly FxNeed[]): Promise<readonly FxOutcome[]> {
    const outcomes = new Map<string, FxOutcome>();
    const current = needs.filter((need) => need.mode === "latest");
    const historical = needs.filter((need) => need.mode === "historical");
    if (current.length > 0) await this.fetchCurrentFx(current, outcomes);
    await Promise.all(historical.map(async (need) => this.fetchHistoricalFx(need, outcomes)));
    return needs.map(
      (need) =>
        outcomes.get(fxNeedKey(need)) ?? {
          need,
          ok: false,
          error: { kind: "invalid-response", message: "CoinGecko omitted a requested FX rate." },
        },
    );
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

  private async fetchCurrentFx(
    needs: readonly FxNeed[],
    outcomes: Map<string, FxOutcome>,
  ): Promise<void> {
    const supported: Array<{ need: FxNeed; identifier: string }> = [];
    for (const need of needs) {
      if (need.identifier === undefined) {
        outcomes.set(fxNeedKey(need), {
          need,
          ok: false,
          error: { kind: "unsupported", message: "CoinGecko requires a currency binding." },
        });
      } else {
        supported.push({ need, identifier: need.identifier });
      }
    }
    if (supported.length === 0) return;
    const currency = "eur";
    let prices: readonly CoinGeckoPrice[];
    try {
      prices = await this.gateway.pricesFor(
        supported.map(({ identifier }) => identifier),
        currency,
      );
    } catch (error) {
      const failure: ProviderFailure =
        error instanceof Error
          ? coingeckoFailure(error, "CoinGecko FX request failed.")
          : { kind: "unavailable", message: "CoinGecko FX request failed." };
      for (const { need } of supported)
        outcomes.set(fxNeedKey(need), { need, ok: false, error: failure });
      return;
    }
    for (const { need, identifier } of supported) {
      const price = prices.find((candidate) => candidate.id === identifier);
      const asOf = price?.asOf === undefined ? dateOnly(this.now()) : dateOnly(price.asOf);
      if (price === undefined) {
        outcomes.set(fxNeedKey(need), {
          need,
          ok: false,
          error: { kind: "not-found", message: `CoinGecko returned no price for ${identifier}.` },
        });
      } else if (asOf === undefined || !Number.isFinite(price.price) || price.price <= 0) {
        outcomes.set(fxNeedKey(need), {
          need,
          ok: false,
          error: {
            kind: "invalid-response",
            message: `CoinGecko returned an invalid FX price for ${identifier}.`,
          },
        });
      } else {
        outcomes.set(fxNeedKey(need), {
          need,
          ok: true,
          data: {
            pair: `${need.currency}/EUR`,
            rate: plainAmount(price.price, "EUR"),
            asOf,
            provenance: {
              kind: "fetched",
              source: "coingecko",
              retrievedAt: this.now().toISOString(),
            },
          },
        });
      }
    }
  }

  private async fetchHistoricalFx(need: FxNeed, outcomes: Map<string, FxOutcome>): Promise<void> {
    if (need.identifier === undefined) {
      outcomes.set(fxNeedKey(need), {
        need,
        ok: false,
        error: { kind: "unsupported", message: "CoinGecko requires a currency binding." },
      });
      return;
    }
    let points: readonly CoinGeckoHistoryPoint[];
    try {
      points = await this.gateway.historyFor(need.identifier, "eur", need.asOf);
    } catch (error) {
      outcomes.set(fxNeedKey(need), {
        need,
        ok: false,
        error:
          error instanceof Error
            ? coingeckoFailure(error, "CoinGecko historical FX request failed.")
            : { kind: "unavailable", message: "CoinGecko historical FX request failed." },
      });
      return;
    }
    const selected = latestPoint(points, need.asOf);
    const asOf = selected === undefined ? undefined : dateOnly(new Date(selected.timestamp));
    if (
      selected === undefined ||
      asOf === undefined ||
      !Number.isFinite(selected.price) ||
      selected.price <= 0
    ) {
      outcomes.set(fxNeedKey(need), {
        need,
        ok: false,
        error: {
          kind: "not-found",
          message: `CoinGecko returned no FX history for ${need.identifier}.`,
        },
      });
      return;
    }
    outcomes.set(fxNeedKey(need), {
      need,
      ok: true,
      data: {
        pair: `${need.currency}/EUR`,
        rate: plainAmount(selected.price, "EUR"),
        asOf,
        provenance: { kind: "fetched", source: "coingecko", retrievedAt: this.now().toISOString() },
      },
    });
  }

  private async fetchCurrent(
    needs: readonly PriceNeed[],
    outcomes: Map<string, PriceOutcome>,
  ): Promise<void> {
    const currency = needs[0]?.instrument.quoteCurrency;
    if (
      currency === undefined ||
      needs.some((need) => need.instrument.quoteCurrency !== currency)
    ) {
      for (const need of needs) {
        outcomes.set(priceNeedKey(need), {
          need,
          ok: false,
          error: {
            kind: "invalid-response",
            message: "CoinGecko batches one quote currency at a time.",
          },
        });
      }
      return;
    }
    let prices: readonly CoinGeckoPrice[];
    try {
      prices = await this.gateway.pricesFor(
        needs.map((need) => need.identifier),
        currency.toLowerCase(),
      );
    } catch (error) {
      const failure: ProviderFailure =
        error instanceof Error
          ? coingeckoFailure(error, "CoinGecko price request failed.")
          : { kind: "unavailable", message: "CoinGecko price request failed." };
      for (const need of needs)
        outcomes.set(priceNeedKey(need), { need, ok: false, error: failure });
      return;
    }
    for (const need of needs) {
      const price = prices.find((candidate) => candidate.id === need.identifier);
      if (price === undefined) {
        outcomes.set(priceNeedKey(need), {
          need,
          ok: false,
          error: {
            kind: "not-found",
            message: `CoinGecko returned no price for ${need.identifier}.`,
          },
        });
        continue;
      }
      const asOf = price.asOf === undefined ? dateOnly(this.now()) : dateOnly(price.asOf);
      if (asOf === undefined || !Number.isFinite(price.price) || price.price <= 0) {
        outcomes.set(priceNeedKey(need), {
          need,
          ok: false,
          error: {
            kind: "invalid-response",
            message: `CoinGecko returned an invalid price for ${need.identifier}.`,
          },
        });
        continue;
      }
      outcomes.set(priceNeedKey(need), {
        need,
        ok: true,
        data: {
          instrument: need.instrument.id,
          price: {
            amount: plainAmount(price.price, need.instrument.quoteCurrency),
            currency: need.instrument.quoteCurrency,
          },
          asOf,
          provenance: {
            kind: "fetched",
            source: "coingecko",
            retrievedAt: this.now().toISOString(),
          },
        },
      });
    }
  }

  private async fetchHistorical(
    need: PriceNeed,
    outcomes: Map<string, PriceOutcome>,
  ): Promise<void> {
    let points: readonly CoinGeckoHistoryPoint[];
    try {
      points = await this.gateway.historyFor(
        need.identifier,
        need.instrument.quoteCurrency.toLowerCase(),
        need.asOf,
      );
    } catch (error) {
      outcomes.set(priceNeedKey(need), {
        need,
        ok: false,
        error:
          error instanceof Error
            ? coingeckoFailure(error, "CoinGecko historical request failed.")
            : { kind: "unavailable", message: "CoinGecko historical request failed." },
      });
      return;
    }
    const selected = latestPoint(points, need.asOf);
    const asOf = selected === undefined ? undefined : dateOnly(new Date(selected.timestamp));
    if (
      selected === undefined ||
      asOf === undefined ||
      !Number.isFinite(selected.price) ||
      selected.price <= 0
    ) {
      outcomes.set(priceNeedKey(need), {
        need,
        ok: false,
        error: {
          kind: "not-found",
          message: `CoinGecko returned no history for ${need.identifier}.`,
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
          amount: plainAmount(selected.price, need.instrument.quoteCurrency),
          currency: need.instrument.quoteCurrency,
        },
        asOf,
        provenance: { kind: "fetched", source: "coingecko", retrievedAt: this.now().toISOString() },
      },
    });
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
    async pricesFor(ids, currency) {
      const response = await client.simple.price.get({
        ids: ids.join(","),
        vs_currencies: currency,
        include_last_updated_at: true,
        precision: "full",
      });
      return ids.flatMap((id) => {
        const item = response[id];
        if (item === undefined) return [];
        const parsed = CoinGeckoPriceItemSchema.safeParse(item);
        if (!parsed.success) return [];
        const price = parsed.data[currency];
        if (price === undefined) return [];
        const retrievedAt = parsed.data.last_updated_at;
        if (retrievedAt === undefined) return [{ id, price }];
        return [{ id, price, asOf: new Date(retrievedAt * 1000) }];
      });
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
  const date = value.toISOString().slice(0, 10);
  return IsoDateSchema.safeParse(date).success ? date : undefined;
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

function fxNeedKey(need: FxNeed): string {
  return `${need.currency}:${need.asOf}:${need.mode}`;
}

function priceNeedKey(need: PriceNeed): string {
  return `${need.instrument.id}:${need.asOf}:${need.mode}`;
}
