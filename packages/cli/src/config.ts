import {
  CurrencySchema,
  InstrumentIdSchema,
  TimeZoneSchema,
  type FileBookStore,
} from "@finbook/core";
import {
  MarketDataConfigStore,
  ProviderIdSchema,
  RouteKeySchema,
  defaultRoute,
  effectiveRoute,
  type MarketDataConfig,
  type ProviderId,
  type RouteKey,
  type SourceBinding,
} from "@finbook/market-data";

import { notFoundFailure, requireResult, validationFailure } from "./errors.js";
import { formatRows, writeSuccess } from "./output.js";

export type SourceConfigOptions = {
  instrument?: string | undefined;
  currency?: string | undefined;
  provider?: string | undefined;
  identifier?: string | undefined;
};

export function showConfig(
  bookStore: FileBookStore,
  marketDataStore: MarketDataConfigStore,
  json: boolean,
): void {
  const metadata = requireResult(bookStore.loadMetadata());
  const marketData = requireResult(marketDataStore.load());
  const config = { book: { timeZone: metadata.timeZone }, marketData };
  writeSuccess(config, json, JSON.stringify(config, null, 2));
}

export function setTimeZone(store: FileBookStore, value: string, json: boolean): void {
  const timeZone = TimeZoneSchema.safeParse(value);
  if (!timeZone.success) {
    throw validationFailure(
      `Invalid time zone: ${value}.`,
      "Use a valid IANA name such as Europe/Madrid or Atlantic/Canary.",
    );
  }
  const metadata = requireResult(store.setTimeZone(timeZone.data));
  const config = { timeZone: metadata.timeZone };
  writeSuccess(config, json, `time zone set to ${metadata.timeZone}`);
}

export function listProviders(store: MarketDataConfigStore, json: boolean): void {
  const config = requireResult(store.load());
  const providers = ProviderIdSchema.options.map((provider) => ({
    id: provider,
    enabled: !config.disabledProviders.includes(provider),
    credentialEnv: credentialEnv(provider),
    routes: configuredRoutes(provider, config),
  }));
  writeSuccess(
    providers,
    json,
    formatRows(
      ["PROVIDER", "ENABLED", "CREDENTIAL ENV", "ROUTES"],
      providers.map((provider) => [
        provider.id,
        provider.enabled ? "yes" : "no",
        provider.credentialEnv ?? "none",
        provider.routes.join(", "),
      ]),
    ),
  );
}

export function setProviderEnabled(
  store: MarketDataConfigStore,
  value: string,
  enabled: boolean,
  json: boolean,
): void {
  const provider = parseProvider(value);
  const updated = requireResult(
    store.update((config) => ({
      ...config,
      disabledProviders: enabled
        ? config.disabledProviders.filter((candidate) => candidate !== provider)
        : [...new Set([...config.disabledProviders, provider])],
    })),
  );
  writeSuccess(updated, json, `${provider} ${enabled ? "enabled" : "disabled"}`);
}

export function setRoute(
  store: MarketDataConfigStore,
  routeValue: string,
  providerValues: readonly string[],
  json: boolean,
): void {
  const route = parseRoute(routeValue);
  if (providerValues.length === 0) {
    throw validationFailure("Missing providers", "Provide at least one provider for the route.");
  }
  const providers = providerValues.map(parseProvider);
  if (new Set(providers).size !== providers.length) {
    throw validationFailure("Duplicate providers", "List each route provider once.");
  }
  const updated = requireResult(
    store.update((config) => ({ ...config, routes: { ...config.routes, [route]: providers } })),
  );
  writeSuccess(updated, json, `${route} route updated`);
}

export function setSource(
  bookStore: FileBookStore,
  configStore: MarketDataConfigStore,
  options: SourceConfigOptions,
  json: boolean,
): void {
  const binding = sourceBinding(options);
  if (
    binding.kind === "instrument" &&
    !requireResult(bookStore.load()).instruments.some(
      (instrument) => instrument.id === binding.instrument,
    )
  ) {
    throw notFoundFailure("instrument", binding.instrument);
  }
  requireResult(
    configStore.update((config) => ({
      ...config,
      bindings: [
        ...config.bindings.filter((candidate) => !sameSubject(candidate, binding)),
        binding,
      ],
    })),
  );
  writeSuccess(binding, json, `${binding.kind} source binding saved`);
}

export function removeSource(
  store: MarketDataConfigStore,
  options: Pick<SourceConfigOptions, "instrument" | "currency">,
  json: boolean,
): void {
  const subject = sourceSubject(options);
  const updated = requireResult(
    store.update((config) => ({
      ...config,
      bindings: config.bindings.filter((candidate) => !sameSubject(candidate, subject)),
    })),
  );
  writeSuccess(updated, json, `${subject.kind} source binding removed`);
}

function sourceBinding(options: SourceConfigOptions): SourceBinding {
  const subject = sourceSubject(options);
  return {
    ...subject,
    provider: parseProvider(required(options.provider, "--provider")),
    identifier: required(options.identifier, "--identifier"),
  };
}

type SourceSubject =
  | { kind: "instrument"; instrument: string }
  | { kind: "currency"; currency: string };

function sourceSubject(
  options: Pick<SourceConfigOptions, "instrument" | "currency">,
): SourceSubject {
  const hasInstrument = options.instrument !== undefined;
  const hasCurrency = options.currency !== undefined;
  if (hasInstrument === hasCurrency) {
    throw validationFailure(
      "Provide exactly one source subject",
      "Use either --instrument or --currency.",
    );
  }
  if (hasInstrument) {
    return {
      kind: "instrument",
      instrument: parseInstrument(options.instrument),
    };
  }
  return {
    kind: "currency",
    currency: parseCurrency(options.currency),
  };
}

function sameSubject(left: SourceBinding, right: SourceSubject): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "instrument"
    ? right.kind === "instrument" && left.instrument === right.instrument
    : right.kind === "currency" && left.currency === right.currency;
}

function parseProvider(value: string): ProviderId {
  const parsed = ProviderIdSchema.safeParse(value);
  if (!parsed.success) {
    throw validationFailure(
      `Unknown provider: ${value}.`,
      "Use a provider supported by the build.",
    );
  }
  return parsed.data;
}

function parseRoute(value: string): RouteKey {
  const parsed = RouteKeySchema.safeParse(value);
  if (!parsed.success) {
    throw validationFailure(`Unknown route: ${value}.`, "Use a documented market-data route.");
  }
  return parsed.data;
}

function parseInstrument(value: string | undefined): string {
  const parsed = InstrumentIdSchema.safeParse(value);
  if (!parsed.success)
    throw validationFailure("Invalid instrument ID", "Use a valid instrument ID.");
  return parsed.data;
}

function parseCurrency(value: string | undefined): string {
  const parsed = CurrencySchema.safeParse(value);
  if (!parsed.success)
    throw validationFailure("Invalid currency", "Use an uppercase currency code.");
  return parsed.data;
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === "") {
    throw validationFailure(`Missing ${flag}.`, `Provide ${flag}.`);
  }
  return value;
}

function credentialEnv(provider: ProviderId): string | null {
  return provider === "coingecko" ? "FINBOOK_COINGECKO_DEMO_API_KEY" : null;
}

function configuredRoutes(provider: ProviderId, config: MarketDataConfig): string[] {
  const routes: RouteKey[] = [
    "price:stock",
    "price:etf",
    "price:fund",
    "price:crypto",
    "fx",
    "eur-rate:fiat",
    "eur-rate:crypto",
  ];
  return routes
    .filter((route) => effectiveRoute(route, config).includes(provider))
    .map(
      (route) => `${route} (${defaultRoute(route).includes(provider) ? "default" : "override"})`,
    );
}
