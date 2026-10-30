import { effectiveRoute, findBinding } from "./config.js";
import {
  providerSupportsRoute,
  type MarketDataConfig,
  type PriceNeed,
  type FxNeed,
  type ProviderId,
  type ProviderFailure,
  type RouteKey,
} from "./contracts.js";

type ProviderSelection =
  | { ok: true; providers: readonly ProviderId[] }
  | { ok: false; provider: ProviderId | "none"; error: ProviderFailure };

const PRICE_ROUTE_BY_INSTRUMENT_TYPE = {
  stock: "price:stock",
  etf: "price:etf",
  fund: "price:fund",
  etc: "price:etc",
  crypto: "price:crypto",
} as const satisfies Record<PriceNeed["instrument"]["type"], RouteKey>;

export function selectPriceProviders(
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

export function selectFxProviders(
  need: FxNeed,
  config: MarketDataConfig,
  providerOverride: ProviderId | undefined,
): ProviderSelection {
  if (providerOverride !== undefined) return selectProvider(providerOverride, "fx", config);
  const binding = findBinding(config, "currency", need.currency);
  if (binding !== undefined) return selectProvider(binding.provider, "fx", config);
  return selectRouteProviders("fx", config);
}

export function selectHistoricalEurRateProviders(
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

export function providerFxNeed(
  need: FxNeed,
  provider: ProviderId,
  config: MarketDataConfig,
): FxNeed {
  const binding = findBinding(config, "currency", need.currency);
  return binding?.provider === provider ? { ...need, identifier: binding.identifier } : need;
}

export function providerPriceNeed(
  need: PriceNeed,
  provider: ProviderId,
  config: MarketDataConfig,
): PriceNeed {
  const binding = findBinding(config, "instrument", need.instrument.id);
  return binding?.provider === provider ? { ...need, identifier: binding.identifier } : need;
}
