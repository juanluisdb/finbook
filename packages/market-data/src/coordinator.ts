import {
  FileBookStore,
  FxStampSchema,
  IsoDateSchema,
  PositiveDecimalStringSchema,
  PriceStampSchema,
  MoneyValue,
  getPositions,
  priceStampAt,
  fxStampAt,
  withRefreshLock,
  fail,
  succeed,
  type DomainError,
  type Result,
  type BookSnapshot,
} from "@finbook/core";

import { effectiveRoute, findBinding } from "./config.js";
import { DailyResolutions, dailyCycle, dailyTarget, cachedResolution } from "./daily.js";
import type { MarketDataConfig } from "./contracts.js";
import {
  type EurRateNeed,
  type EurRateOutcome,
  type EurRateResolution,
  type FxFetchFailure,
  type FxFetchReport,
  type FxNeed,
  type FxObservation,
  type FxOutcome,
  type FxSource,
  type HistoricalEurRateSource,
  type PriceFetchFailure,
  type PriceFetchReport,
  type PriceNeed,
  type PriceObservation,
  type PriceOutcome,
  type PriceSource,
  type ProviderFailure,
  type ProviderId,
  type RouteKey,
  providerSupportsRoute,
} from "./contracts.js";

export type MarketDataStore = Pick<
  FileBookStore,
  "dataHome" | "load" | "appendPrice" | "appendFx" | "acceptFetchedPrice" | "acceptFetchedFx"
>;

export type MarketDataCoordinatorOptions = {
  store: MarketDataStore;
  config: MarketDataConfig;
  priceSources: readonly PriceSource[];
  fxSources: readonly FxSource[];
  eurRateSources: readonly HistoricalEurRateSource[];
  now?: () => Date;
};

export type ResolvePriceOptions = {
  provider?: ProviderId;
  now?: Date;
};

type PendingPrice = {
  need: PriceNeed;
  providers: readonly ProviderId[];
  providerIndex: number;
  lastFailure: ProviderFailure | undefined;
  resolutionKey: string;
  cycle: string;
};

type PendingFx = {
  need: FxNeed;
  providers: readonly ProviderId[];
  providerIndex: number;
  lastFailure: ProviderFailure | undefined;
  resolutionKey: string;
  cycle: string;
};

type ProviderSelection =
  | { ok: true; providers: readonly ProviderId[] }
  | { ok: false; provider: ProviderId | "none"; error: ProviderFailure };

export type ManualMarkConflict = {
  kind: "price" | "fx";
  subject: string;
  asOf: string;
  manual: string;
  fetched: string;
  currency: string;
  action: "kept" | "replaced";
};

export type ValuationRefreshReport = {
  cycle: string;
  prices: PriceFetchReport;
  fx: FxFetchReport;
  conflicts: readonly ManualMarkConflict[];
};

const PRICE_ROUTE_BY_INSTRUMENT_TYPE = {
  stock: "price:stock",
  etf: "price:etf",
  fund: "price:fund",
  etc: "price:etc",
  crypto: "price:crypto",
} as const satisfies Record<PriceNeed["instrument"]["type"], RouteKey>;

export class MarketDataCoordinator {
  private readonly store: MarketDataStore;
  private readonly config: MarketDataConfig;
  private readonly priceSources: readonly PriceSource[];
  private readonly fxSources: readonly FxSource[];
  private readonly eurRateSources: readonly HistoricalEurRateSource[];
  private readonly now: () => Date;
  private readonly resolutions: DailyResolutions;

  constructor(options: MarketDataCoordinatorOptions) {
    this.store = options.store;
    this.config = options.config;
    this.priceSources = options.priceSources;
    this.fxSources = options.fxSources;
    this.eurRateSources = options.eurRateSources;
    this.now = options.now ?? (() => new Date());
    this.resolutions = new DailyResolutions(this.store.dataHome);
  }

  async refreshValuation(
    asOf: string,
    options: { replaceManual?: boolean } = {},
  ): Promise<Result<{ snapshot: BookSnapshot; report: ValuationRefreshReport }>> {
    const date = IsoDateSchema.safeParse(asOf);
    if (!date.success)
      return fail({
        type: "validation",
        message: "Invalid valuation date.",
        hint: "Use YYYY-MM-DD.",
      });
    return withRefreshLock(this.store.dataHome, async () => {
      const initial = this.store.load();
      if (!initial.ok) return fail(initial.error);
      const positions = getPositions(initial.data, date.data);
      if (!positions.ok) return fail(positions.error);
      const now = this.now();
      const currencies = new Set(positions.data.cash.map((entry) => entry.currency));
      const priceNeeds: PriceNeed[] = [];
      for (const position of positions.data.positions) {
        const instrument = initial.data.instruments.find(
          (value) => value.id === position.instrument,
        );
        if (instrument === undefined) throw new Error("Position refers to an unknown instrument.");
        priceNeeds.push({
          instrument,
          identifier: instrument.id,
          asOf: dailyTarget(date.data, instrument.type === "crypto", now),
        });
        currencies.add(instrument.quoteCurrency);
      }
      const prices = await this.resolvePrices(priceNeeds, { now });
      if (!prices.ok) return fail(prices.error);
      const fxNeeds: FxNeed[] = [...currencies]
        .filter((currency) => currency !== "EUR")
        .map((currency) => ({
          currency,
          asOf: dailyTarget(
            date.data,
            findBinding(this.config, "currency", currency)?.provider === "coingecko",
            now,
          ),
        }));
      const fx = await this.resolveFxRates(fxNeeds, { now });
      if (!fx.ok) return fail(fx.error);
      const current = this.store.load();
      if (!current.ok) return fail(current.error);
      const conflicts = this.resolveManualConflicts(
        initial.data,
        current.data,
        prices.data,
        fx.data,
        options.replaceManual === true,
      );
      if (!conflicts.ok) return fail(conflicts.error);
      const snapshot = this.store.load();
      if (!snapshot.ok) return fail(snapshot.error);
      return succeed({
        snapshot: snapshot.data,
        report: {
          cycle: dailyCycle(now),
          prices: prices.data,
          fx: fx.data,
          conflicts: conflicts.data,
        },
      });
    });
  }

  private resolveManualConflicts(
    initial: BookSnapshot,
    current: BookSnapshot,
    prices: PriceFetchReport,
    fx: FxFetchReport,
    replace: boolean,
  ): Result<readonly ManualMarkConflict[]> {
    const conflicts: ManualMarkConflict[] = [];
    for (const candidate of prices.resolved) {
      const manual = priceStampAt(candidate.instrument, candidate.asOf, current.prices);
      if (
        manual?.provenance.kind !== "manual" ||
        manual.asOf !== candidate.asOf ||
        MoneyValue.from(manual.price).subtract(MoneyValue.from(candidate.price)).isZero()
      )
        continue;
      if (replace) {
        const expected = initial.prices.filter(
          (mark) =>
            mark.instrument === candidate.instrument &&
            mark.asOf === candidate.asOf &&
            mark.provenance.kind === "manual",
        );
        const accepted = this.store.acceptFetchedPrice(candidate, expected);
        if (!accepted.ok) return fail(accepted.error);
      }
      conflicts.push({
        kind: "price",
        subject: candidate.instrument,
        asOf: candidate.asOf,
        manual: manual.price.amount,
        fetched: candidate.price.amount,
        currency: candidate.price.currency,
        action: replace ? "replaced" : "kept",
      });
    }
    for (const candidate of fx.resolved) {
      const manual = fxStampAt(candidate.pair.slice(0, -4), candidate.asOf, current.fx);
      if (
        manual?.provenance.kind !== "manual" ||
        manual.asOf !== candidate.asOf ||
        MoneyValue.from({ amount: manual.rate, currency: "EUR" })
          .subtract(MoneyValue.from({ amount: candidate.rate, currency: "EUR" }))
          .isZero()
      )
        continue;
      if (replace) {
        const expected = initial.fx.filter(
          (mark) =>
            mark.pair === candidate.pair &&
            mark.asOf === candidate.asOf &&
            mark.provenance.kind === "manual",
        );
        const accepted = this.store.acceptFetchedFx(candidate, expected);
        if (!accepted.ok) return fail(accepted.error);
      }
      conflicts.push({
        kind: "fx",
        subject: candidate.pair,
        asOf: candidate.asOf,
        manual: manual.rate,
        fetched: candidate.rate,
        currency: "EUR",
        action: replace ? "replaced" : "kept",
      });
    }
    return succeed(conflicts);
  }

  async resolvePrices(
    requestedNeeds: readonly PriceNeed[],
    options: ResolvePriceOptions = {},
  ): Promise<Result<PriceFetchReport>> {
    const snapshot = this.store.load();
    if (!snapshot.ok) return fail(snapshot.error);
    const records = this.resolutions.load();
    if (!records.ok) return fail(records.error);
    const cycle = dailyCycle(options.now ?? this.now());

    const needs = uniquePriceNeeds(requestedNeeds);
    const pending = new Map<string, PendingPrice>();
    const failures: PriceFetchFailure[] = [];
    const reused: PriceObservation[] = [];
    let cached = 0;

    for (const need of needs) {
      const selection = selectPriceProviders(need, this.config, options.provider);
      if (!selection.ok) {
        failures.push({ need, provider: selection.provider, error: selection.error });
        continue;
      }
      const resolutionKey = JSON.stringify([
        "price",
        need.instrument.id,
        need.instrument.type,
        need.instrument.quoteCurrency,
        need.asOf,
        selection.providers.map((provider) => [
          provider,
          providerPriceNeed(need, provider, this.config).identifier,
        ]),
      ]);
      const cachedRecord = cachedResolution(
        records.data,
        resolutionKey,
        cycle,
        need.asOf,
        snapshot.data,
      );
      if (
        cachedRecord?.observation.kind === "price" &&
        cachedRecord.observation.mark.provenance.kind === "fetched"
      ) {
        const mark = cachedRecord.observation.mark;
        reused.push({ ...mark, provenance: cachedRecord.observation.mark.provenance });
        cached += 1;
        continue;
      }
      pending.set(priceNeedKey(need), {
        need,
        providers: selection.providers,
        providerIndex: 0,
        lastFailure: undefined,
        resolutionKey,
        cycle,
      });
    }

    const fetched: PriceObservation[] = [];
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

    return succeed({
      requested: needs.length,
      cached,
      fetched,
      resolved: [...reused, ...fetched],
      failures,
    });
  }

  async resolveFxRates(
    requestedNeeds: readonly FxNeed[],
    options: ResolvePriceOptions = {},
  ): Promise<Result<FxFetchReport>> {
    const snapshot = this.store.load();
    if (!snapshot.ok) return fail(snapshot.error);
    const records = this.resolutions.load();
    if (!records.ok) return fail(records.error);
    const cycle = dailyCycle(options.now ?? this.now());

    const needs = uniqueFxNeeds(requestedNeeds);
    const pending = new Map<string, PendingFx>();
    const failures: FxFetchFailure[] = [];
    const reused: FxObservation[] = [];
    let cached = 0;

    for (const need of needs) {
      const selection = selectFxProviders(need, this.config, options.provider);
      if (!selection.ok) {
        failures.push({ need, provider: selection.provider, error: selection.error });
        continue;
      }
      const resolutionKey = JSON.stringify([
        "fx",
        need.currency,
        need.asOf,
        selection.providers.map((provider) => [
          provider,
          providerFxNeed(need, provider, this.config).identifier,
        ]),
      ]);
      const cachedRecord = cachedResolution(
        records.data,
        resolutionKey,
        cycle,
        need.asOf,
        snapshot.data,
      );
      if (
        cachedRecord?.observation.kind === "fx" &&
        cachedRecord.observation.mark.provenance.kind === "fetched"
      ) {
        const mark = cachedRecord.observation.mark;
        reused.push({ ...mark, provenance: cachedRecord.observation.mark.provenance });
        cached += 1;
        continue;
      }
      pending.set(fxNeedKey(need), {
        need,
        providers: selection.providers,
        providerIndex: 0,
        lastFailure: undefined,
        resolutionKey,
        cycle,
      });
    }

    const fetched: FxObservation[] = [];
    while (pending.size > 0) {
      const groups = groupPendingFx(pending);
      if (groups.size === 0) {
        collectExhaustedFxFailures(pending, failures);
        break;
      }
      for (const [provider, group] of groups) {
        try {
          await this.resolveFxGroup(provider, group, pending, fetched, failures);
        } catch (error) {
          if (error instanceof CoordinatorStorageError) return fail(error.domainError);
          throw error;
        }
      }
    }

    return succeed({
      requested: needs.length,
      cached,
      fetched,
      resolved: [...reused, ...fetched],
      failures,
    });
  }

  async resolveHistoricalEurRate(
    need: EurRateNeed,
    options: ResolvePriceOptions = {},
  ): Promise<EurRateResolution> {
    const bindingCandidate = findBinding(this.config, "currency", need.currency);
    const binding = bindingCandidate?.kind === "currency" ? bindingCandidate : undefined;
    const selection = selectHistoricalEurRateProviders(binding, this.config, options.provider);
    if (!selection.ok) return { ok: false, error: selection.error };
    let lastFailure: ProviderFailure | undefined;

    for (const provider of selection.providers) {
      const source = this.eurRateSources.find((candidate) => candidate.id === provider);
      if (source === undefined) {
        lastFailure = {
          kind: "unavailable",
          message: `Provider ${provider} is not available in this build.`,
        };
        continue;
      }
      const providerNeed =
        binding?.provider === provider ? { ...need, identifier: binding.identifier } : need;
      let outcomes: readonly EurRateOutcome[];
      try {
        outcomes = await source.fetchHistoricalEurRates([providerNeed]);
      } catch (error) {
        lastFailure = {
          kind: "unavailable",
          message: error instanceof Error ? error.message : "Provider request failed.",
        };
        continue;
      }
      const outcome = outcomes[0];
      if (outcome === undefined) {
        lastFailure = {
          kind: "invalid-response",
          message: `Provider ${provider} omitted ${need.currency}.`,
        };
        continue;
      }
      if (!outcome.ok) {
        lastFailure = outcome.error;
        continue;
      }
      const rate = PositiveDecimalStringSchema.safeParse(outcome.data.rate);
      const effectiveDate = IsoDateSchema.safeParse(outcome.data.effectiveDate);
      if (!rate.success || !effectiveDate.success) {
        lastFailure = {
          kind: "invalid-response",
          message: `Provider ${provider} returned an invalid EUR rate.`,
        };
        continue;
      }
      if (effectiveDate.data > need.date) {
        lastFailure = {
          kind: "invalid-response",
          message: `Provider ${provider} returned a future EUR rate.`,
        };
        continue;
      }
      if (outcome.data.provenance.kind !== "fetched") {
        lastFailure = {
          kind: "invalid-response",
          message: `Provider ${provider} returned a non-fetched EUR rate.`,
        };
        continue;
      }
      return {
        ok: true,
        data: {
          rate: rate.data,
          effectiveDate: effectiveDate.data,
          provenance: outcome.data.provenance,
        },
      };
    }

    const error = lastFailure ?? {
      kind: "unavailable" as const,
      message: `No provider is configured for ${need.currency}.`,
    };
    if (binding === undefined && (error.kind === "unsupported" || error.kind === "not-found")) {
      return {
        ok: false,
        error: {
          ...error,
          message: `${error.message} Bind it with: finbook config source set --currency ${need.currency} --provider coingecko --identifier <provider-id>.`,
        },
      };
    }
    return { ok: false, error };
  }

  private async resolveFxGroup(
    provider: ProviderId,
    group: readonly PendingFx[],
    pending: Map<string, PendingFx>,
    fetched: FxObservation[],
    failures: FxFetchFailure[],
  ): Promise<void> {
    const source = this.fxSources.find((candidate) => candidate.id === provider);
    if (source === undefined) {
      for (const item of group)
        advanceFx(item, {
          kind: "unavailable",
          message: `Provider ${provider} is not available in this build.`,
        });
      return;
    }

    const needs = group.map((item) => providerFxNeed(item.need, provider, this.config));
    let outcomes: readonly FxOutcome[];
    try {
      outcomes = await source.fetchFxRates(needs);
    } catch (error) {
      const failure: ProviderFailure = {
        kind: "unavailable",
        message: error instanceof Error ? error.message : "Provider request failed.",
      };
      for (const item of group) advanceFx(item, failure);
      return;
    }

    const outcomeByKey = new Map(outcomes.map((outcome) => [fxNeedKey(outcome.need), outcome]));
    for (const item of group) {
      const key = fxNeedKey(item.need);
      const outcome = outcomeByKey.get(key);
      if (outcome === undefined) {
        advanceFx(item, {
          kind: "invalid-response",
          message: `Provider ${provider} omitted ${item.need.currency}.`,
        });
        continue;
      }
      if (!outcome.ok) {
        advanceFx(item, outcome.error);
        continue;
      }

      const observation = validateFxObservation(item.need, outcome.data);
      if (!observation.ok) {
        advanceFx(item, { kind: "invalid-response", message: observation.error.message });
        continue;
      }
      const appended = this.store.appendFx(observation.data);
      if (!appended.ok) throw new CoordinatorStorageError(appended.error);
      const recorded = this.resolutions.save({
        key: item.resolutionKey,
        cycle: item.cycle,
        checkedAt: this.now().toISOString(),
        observation: { kind: "fx", mark: observation.data },
      });
      if (!recorded.ok) throw new CoordinatorStorageError(recorded.error);
      pending.delete(key);
      fetched.push(observation.data);
    }

    for (const item of group) {
      if (!pending.has(fxNeedKey(item.need))) continue;
      if (item.providerIndex < item.providers.length) continue;
      const failure = item.lastFailure ?? {
        kind: "unavailable" as const,
        message: `No provider returned ${item.need.currency}.`,
      };
      failures.push({ need: item.need, provider, error: failure });
      pending.delete(fxNeedKey(item.need));
    }
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
      const recorded = this.resolutions.save({
        key: item.resolutionKey,
        cycle: item.cycle,
        checkedAt: this.now().toISOString(),
        observation: { kind: "price", mark: observation.data },
      });
      if (!recorded.ok) throw new CoordinatorStorageError(recorded.error);
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

function selectPriceProviders(
  need: PriceNeed,
  config: MarketDataConfig,
  providerOverride: ProviderId | undefined,
): ProviderSelection {
  const route = priceRoute(need.instrument.type);
  const binding = findBinding(config, "instrument", need.instrument.id);
  if (providerOverride !== undefined) return selectProvider(providerOverride, route, config);
  if (binding !== undefined) return selectProvider(binding.provider, route, config);
  return selectRouteProviders(route, config);
}

function selectFxProviders(
  need: FxNeed,
  config: MarketDataConfig,
  providerOverride: ProviderId | undefined,
): ProviderSelection {
  if (providerOverride !== undefined) return selectProvider(providerOverride, "fx", config);
  const binding = findBinding(config, "currency", need.currency);
  if (binding !== undefined) return selectProvider(binding.provider, "fx", config);
  return selectRouteProviders("fx", config);
}

function selectHistoricalEurRateProviders(
  binding: Extract<MarketDataConfig["bindings"][number], { kind: "currency" }> | undefined,
  config: MarketDataConfig,
  providerOverride: ProviderId | undefined,
): ProviderSelection {
  const route =
    binding !== undefined && providerSupportsRoute(binding.provider, "eur-rate:crypto")
      ? "eur-rate:crypto"
      : "eur-rate:fiat";
  if (providerOverride !== undefined) {
    return selectProvider(providerOverride, route, config);
  }
  if (binding !== undefined) {
    return selectProvider(binding.provider, route, config);
  }
  return selectRouteProviders("eur-rate:fiat", config);
}

function selectProvider(
  provider: ProviderId,
  route: RouteKey,
  config: MarketDataConfig,
): ProviderSelection {
  if (config.disabledProviders.includes(provider)) {
    return {
      ok: false,
      provider,
      error: { kind: "unsupported", message: `Provider ${provider} is disabled.` },
    };
  }
  if (!providerSupportsRoute(provider, route)) {
    return {
      ok: false,
      provider,
      error: { kind: "unsupported", message: `Provider ${provider} cannot serve ${route}.` },
    };
  }
  return { ok: true, providers: [provider] };
}

function selectRouteProviders(route: RouteKey, config: MarketDataConfig): ProviderSelection {
  const providers = effectiveRoute(route, config);
  if (providers.length === 0) {
    return {
      ok: false,
      provider: "none",
      error: { kind: "unavailable", message: `No enabled provider is configured for ${route}.` },
    };
  }
  return { ok: true, providers };
}

function priceRoute(type: PriceNeed["instrument"]["type"]): RouteKey {
  return PRICE_ROUTE_BY_INSTRUMENT_TYPE[type];
}

function providerFxNeed(need: FxNeed, provider: ProviderId, config: MarketDataConfig): FxNeed {
  const binding = findBinding(config, "currency", need.currency);
  return binding?.provider === provider ? { ...need, identifier: binding.identifier } : need;
}

function providerPriceNeed(
  need: PriceNeed,
  provider: ProviderId,
  config: MarketDataConfig,
): PriceNeed {
  const binding = findBinding(config, "instrument", need.instrument.id);
  return binding?.provider === provider ? { ...need, identifier: binding.identifier } : need;
}

function groupPendingFx(pending: Map<string, PendingFx>): Map<ProviderId, PendingFx[]> {
  const groups = new Map<ProviderId, PendingFx[]>();
  for (const item of pending.values()) {
    const provider = item.providers[item.providerIndex];
    if (provider === undefined) continue;
    const group = groups.get(provider) ?? [];
    group.push(item);
    groups.set(provider, group);
  }
  return groups;
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

function collectExhaustedFxFailures(
  pending: Map<string, PendingFx>,
  failures: FxFetchFailure[],
): void {
  for (const item of pending.values()) {
    failures.push({
      need: item.need,
      provider: item.providers[item.providerIndex - 1] ?? "none",
      error: item.lastFailure ?? {
        kind: "unavailable",
        message: "No provider is configured for this FX request.",
      },
    });
  }
  pending.clear();
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

function advanceFx(item: PendingFx, failure: ProviderFailure): void {
  item.lastFailure = failure;
  item.providerIndex += 1;
}

function advancePrice(item: PendingPrice, failure: ProviderFailure): void {
  item.lastFailure = failure;
  item.providerIndex += 1;
}

function validateFxObservation(need: FxNeed, observation: FxObservation): Result<FxObservation> {
  const parsed = FxStampSchema.safeParse(observation);
  if (!parsed.success) {
    return fail({
      type: "validation",
      message: "Provider returned an invalid FX mark.",
      hint: "Inspect the provider adapter response schema.",
    });
  }
  const { provenance } = parsed.data;
  if (provenance.kind !== "fetched") {
    return fail({
      type: "validation",
      message: "Provider returned a manual FX mark.",
      hint: "Use fetched provenance for provider observations.",
    });
  }
  if (parsed.data.pair !== `${need.currency}/EUR`) {
    return fail({
      type: "validation",
      message: `Provider returned ${parsed.data.pair}, not ${need.currency}/EUR.`,
      hint: "Fix the provider currency mapping.",
    });
  }
  if (parsed.data.asOf > need.asOf) {
    return fail({
      type: "validation",
      message: `Provider returned a future FX mark for ${need.currency}.`,
      hint: "Use a mark dated on or before the requested date.",
    });
  }
  return succeed({ ...parsed.data, provenance });
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

function uniqueFxNeeds(needs: readonly FxNeed[]): readonly FxNeed[] {
  const unique = new Map<string, FxNeed>();
  for (const need of needs) unique.set(fxNeedKey(need), need);
  return [...unique.values()];
}

function uniquePriceNeeds(needs: readonly PriceNeed[]): readonly PriceNeed[] {
  const unique = new Map<string, PriceNeed>();
  for (const need of needs) unique.set(priceNeedKey(need), need);
  return [...unique.values()];
}

function fxNeedKey(need: FxNeed): string {
  return `${need.currency}:${need.asOf}`;
}

function priceNeedKey(need: PriceNeed): string {
  return `${need.instrument.id}:${need.asOf}`;
}
