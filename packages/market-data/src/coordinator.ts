import {
  FileBookStore,
  PriceStampSchema,
  fail,
  succeed,
  type DomainError,
  type PriceStamp,
  type Result,
} from "@finbook/core";

import { effectiveRoute, findBinding } from "./config.js";
import type { MarketDataConfig } from "./contracts.js";
import {
  type PriceFetchFailure,
  type PriceFetchReport,
  type PriceNeed,
  type PriceObservation,
  type PriceOutcome,
  type PriceSource,
  type ProviderFailure,
  type ProviderId,
} from "./contracts.js";

export type MarketDataStore = Pick<FileBookStore, "load" | "appendPrice">;

export type MarketDataCoordinatorOptions = {
  store: MarketDataStore;
  config: MarketDataConfig;
  priceSources: readonly PriceSource[];
  now?: () => Date;
};

export type ResolvePriceOptions = {
  provider?: ProviderId;
};

type PendingPrice = {
  need: PriceNeed;
  providers: readonly ProviderId[];
  providerIndex: number;
  lastFailure: ProviderFailure | undefined;
};

export class MarketDataCoordinator {
  private readonly store: MarketDataStore;
  private readonly config: MarketDataConfig;
  private readonly priceSources: readonly PriceSource[];
  private readonly now: () => Date;

  constructor(options: MarketDataCoordinatorOptions) {
    this.store = options.store;
    this.config = options.config;
    this.priceSources = options.priceSources;
    this.now = options.now ?? (() => new Date());
  }

  async resolvePrices(
    requestedNeeds: readonly PriceNeed[],
    options: ResolvePriceOptions = {},
  ): Promise<Result<PriceFetchReport>> {
    const snapshot = this.store.load();
    if (!snapshot.ok) return fail(snapshot.error);

    const needs = uniquePriceNeeds(requestedNeeds);
    const today = this.now().toISOString().slice(0, 10);
    const pending = new Map<string, PendingPrice>();
    let cached = 0;

    for (const need of needs) {
      if (priceIsCached(snapshot.data.prices, need, today)) {
        cached += 1;
        continue;
      }
      pending.set(priceNeedKey(need), {
        need,
        providers: priceProviders(need, this.config, options.provider),
        providerIndex: 0,
        lastFailure: undefined,
      });
    }

    const fetched: PriceObservation[] = [];
    const failures: PriceFetchFailure[] = [];
    while (pending.size > 0) {
      const groups = groupPendingPrices(pending);
      if (groups.size === 0) {
        collectExhaustedFailures(pending, failures);
        break;
      }

      for (const [provider, group] of groups) {
        try {
          await this.resolvePriceGroup(provider, group, pending, fetched, failures);
        } catch (error) {
          if (error instanceof CoordinatorStorageError) return fail(error.domainError);
          throw error;
        }
      }
    }

    return succeed({ requested: needs.length, cached, fetched, failures });
  }

  private async resolvePriceGroup(
    provider: ProviderId,
    group: readonly PendingPrice[],
    pending: Map<string, PendingPrice>,
    fetched: PriceObservation[],
    failures: PriceFetchFailure[],
  ): Promise<void> {
    const source = this.priceSources.find((candidate) => candidate.id === provider);
    if (source === undefined) {
      for (const item of group)
        advancePrice(item, {
          kind: "unavailable",
          message: `Provider ${provider} is not available in this build.`,
        });
      return;
    }

    const needs = group.map((item) => providerPriceNeed(item.need, provider, this.config));
    let outcomes: readonly PriceOutcome[];
    try {
      outcomes = await source.fetchPrices(needs);
    } catch (error) {
      const failure: ProviderFailure = {
        kind: "unavailable",
        message: error instanceof Error ? error.message : "Provider request failed.",
      };
      for (const item of group) advancePrice(item, failure);
      return;
    }

    const outcomeByKey = new Map(outcomes.map((outcome) => [priceNeedKey(outcome.need), outcome]));
    for (const item of group) {
      const key = priceNeedKey(item.need);
      const outcome = outcomeByKey.get(key);
      if (outcome === undefined) {
        advancePrice(item, {
          kind: "invalid-response",
          message: `Provider ${provider} omitted ${item.need.instrument.id}.`,
        });
        continue;
      }
      if (!outcome.ok) {
        advancePrice(item, outcome.error);
        continue;
      }

      const observation = validateObservation(item.need, outcome.data);
      if (!observation.ok) {
        advancePrice(item, {
          kind: "invalid-response",
          message: observation.error.message,
        });
        continue;
      }
      const appended = this.store.appendPrice(observation.data);
      if (!appended.ok) {
        throw new CoordinatorStorageError(appended.error);
      }
      pending.delete(key);
      fetched.push(observation.data);
    }

    for (const item of group) {
      if (!pending.has(priceNeedKey(item.need))) continue;
      if (item.providerIndex < item.providers.length) continue;
      const failure = item.lastFailure ?? {
        kind: "unavailable",
        message: `No provider returned ${item.need.instrument.id}.`,
      };
      failures.push({ need: item.need, provider, error: failure });
      pending.delete(priceNeedKey(item.need));
    }
  }
}

class CoordinatorStorageError extends Error {
  readonly domainError: DomainError;

  constructor(error: DomainError) {
    super(error.message);
    this.name = "CoordinatorStorageError";
    this.domainError = error;
  }
}

function priceProviders(
  need: PriceNeed,
  config: MarketDataConfig,
  providerOverride: ProviderId | undefined,
): readonly ProviderId[] {
  if (providerOverride !== undefined) return [providerOverride];
  const binding = findBinding(config, "instrument", need.instrument.id);
  if (binding !== undefined) return [binding.provider];
  return effectiveRoute(`price:${need.instrument.type}`, config);
}

function providerPriceNeed(
  need: PriceNeed,
  provider: ProviderId,
  config: MarketDataConfig,
): PriceNeed {
  const binding = findBinding(config, "instrument", need.instrument.id);
  return binding?.provider === provider ? { ...need, identifier: binding.identifier } : need;
}

function groupPendingPrices(pending: Map<string, PendingPrice>): Map<ProviderId, PendingPrice[]> {
  const groups = new Map<ProviderId, PendingPrice[]>();
  for (const item of pending.values()) {
    const provider = item.providers[item.providerIndex];
    if (provider === undefined) continue;
    const group = groups.get(provider) ?? [];
    group.push(item);
    groups.set(provider, group);
  }
  return groups;
}

function collectExhaustedFailures(
  pending: Map<string, PendingPrice>,
  failures: PriceFetchFailure[],
): void {
  for (const item of pending.values()) {
    failures.push({
      need: item.need,
      provider: item.providers[item.providerIndex - 1] ?? "none",
      error: item.lastFailure ?? {
        kind: "unavailable",
        message: "No provider is configured for this price request.",
      },
    });
  }
  pending.clear();
}

function advancePrice(item: PendingPrice, failure: ProviderFailure): void {
  item.lastFailure = failure;
  item.providerIndex += 1;
}

function validateObservation(
  need: PriceNeed,
  observation: PriceObservation,
): Result<PriceObservation> {
  const parsed = PriceStampSchema.safeParse(observation);
  if (!parsed.success) {
    return fail({
      type: "validation",
      message: "Provider returned an invalid price mark.",
      hint: "Inspect the provider adapter response schema.",
    });
  }
  const { provenance } = parsed.data;
  if (provenance.kind !== "fetched") {
    return fail({
      type: "validation",
      message: "Provider returned a manual price mark.",
      hint: "Use fetched provenance for provider observations.",
    });
  }
  if (parsed.data.instrument !== need.instrument.id) {
    return fail({
      type: "validation",
      message: `Provider returned a price for ${parsed.data.instrument}, not ${need.instrument.id}.`,
      hint: "Fix the provider instrument mapping.",
    });
  }
  if (parsed.data.price.currency !== need.instrument.quoteCurrency) {
    return fail({
      type: "validation",
      message: `Provider returned ${parsed.data.price.currency} for ${need.instrument.quoteCurrency}.`,
      hint: "Fix the provider quote currency mapping.",
    });
  }
  if (parsed.data.asOf > need.asOf) {
    return fail({
      type: "validation",
      message: `Provider returned a future price for ${need.instrument.id}.`,
      hint: "Use a mark dated on or before the requested date.",
    });
  }
  return succeed({ ...parsed.data, provenance });
}

function uniquePriceNeeds(needs: readonly PriceNeed[]): readonly PriceNeed[] {
  const unique = new Map<string, PriceNeed>();
  for (const need of needs) unique.set(priceNeedKey(need), need);
  return [...unique.values()];
}

function priceNeedKey(need: PriceNeed): string {
  return `${need.instrument.id}:${need.asOf}:${need.mode}`;
}

function priceIsCached(prices: readonly PriceStamp[], need: PriceNeed, today: string): boolean {
  return prices.some((stamp) => {
    if (stamp.instrument !== need.instrument.id) return false;
    if (need.mode === "historical") return stamp.asOf <= need.asOf;
    return stamp.provenance.kind === "fetched" && stamp.provenance.retrievedAt.startsWith(today);
  });
}
