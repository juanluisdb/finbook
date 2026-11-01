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
  type ProviderId,
  type RouteKey,
  type ProviderPackages,
  type SourceBinding,
} from "@finbook/market-data";

import { notFoundFailure, requireResult, validationFailure } from "./errors.js";
import { writeSuccess } from "./output.js";

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

export async function setRoute(
  store: MarketDataConfigStore,
  routeValue: string,
  providerValues: readonly string[],
  json: boolean,
  packages: ProviderPackages,
): Promise<void> {
  const route = parseRoute(routeValue);
  if (providerValues.length === 0) {
    throw validationFailure("Missing providers", "Provide at least one provider for the route.");
  }
  const providers = providerValues.map(parseProvider);
  if (new Set(providers).size !== providers.length) {
    throw validationFailure("Duplicate providers", "List each route provider once.");
  }
  for (const provider of providers) await requireCapability(packages, provider, [route]);
  const updated = requireResult(
    store.update((config) => ({ ...config, routes: { ...config.routes, [route]: providers } })),
  );
  writeSuccess(updated, json, `${route} route updated`);
}

export async function setSource(
  bookStore: FileBookStore,
  configStore: MarketDataConfigStore,
  options: SourceConfigOptions,
  json: boolean,
  packages: ProviderPackages,
): Promise<void> {
  const binding = sourceBinding(options);
  let routes = ["fx", "eur-rate:fiat", "eur-rate:crypto"];
  if (binding.kind === "instrument") {
    const instrument = requireResult(bookStore.load()).instruments.find(
      (candidate) => candidate.id === binding.instrument,
    );
    if (instrument === undefined) throw notFoundFailure("instrument", binding.instrument);
    routes = [`price:${instrument.type}`];
  }
  await requireCapability(packages, binding.provider, routes);
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
      `Invalid provider ID: ${value}.`,
      "Use a provider ID from `finbook provider list`.",
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

export function removeRoute(store: MarketDataConfigStore, value: string, json: boolean): void {
  const route = parseRoute(value);
  const updated = requireResult(
    store.update((config) => {
      const routes = { ...config.routes };
      delete routes[route];
      return { ...config, routes };
    }),
  );
  writeSuccess(updated, json, `${route} route removed`);
}

async function requireCapability(
  packages: ProviderPackages,
  id: string,
  routes: readonly string[],
): Promise<void> {
  const provider = requireResult(await packages.find(id));
  if (!provider.metadata.capabilities.some((capability) => routes.includes(capability)))
    throw validationFailure(
      `Provider ${id} cannot serve ${routes.join(" or ")}.`,
      "Choose a provider with the required declared capability.",
    );
}
