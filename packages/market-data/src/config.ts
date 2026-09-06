import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import { fail, succeed, type DomainError, type Result, withBookLock } from "@finbook/core";

import {
  MarketDataConfigSchema,
  type MarketDataConfig,
  type ProviderId,
  type RouteKey,
  type SourceBinding,
  providerSupportsRoute,
} from "./contracts.js";

const CONFIG_FILE = "market-data.json";

const DEFAULT_ROUTES = {
  "price:stock": ["yahoo"],
  "price:etf": ["yahoo"],
  "price:fund": ["yahoo"],
  "price:etc": ["yahoo"],
  "price:crypto": ["coingecko"],
  fx: ["ecb"],
  "eur-rate:fiat": ["ecb"],
  "eur-rate:crypto": ["coingecko"],
} as const satisfies Record<RouteKey, readonly ProviderId[]>;

export function defaultMarketDataConfig(): MarketDataConfig {
  return MarketDataConfigSchema.parse({
    disabledProviders: [],
    routes: {},
    bindings: [],
  });
}

export function defaultRoute(key: RouteKey): readonly ProviderId[] {
  return DEFAULT_ROUTES[key];
}

export function effectiveRoute(key: RouteKey, config: MarketDataConfig): readonly ProviderId[] {
  const configured = config.routes[key] ?? defaultRoute(key);
  return configured.filter(
    (provider) =>
      providerSupportsRoute(provider, key) && !config.disabledProviders.includes(provider),
  );
}

export function findBinding(
  config: MarketDataConfig,
  kind: SourceBinding["kind"],
  localId: string,
): SourceBinding | undefined {
  return config.bindings.find((binding) => {
    if (binding.kind !== kind) return false;
    return binding.kind === "instrument"
      ? binding.instrument === localId
      : binding.currency === localId;
  });
}

export type MarketDataConfigInspection = {
  exists: boolean;
  config: MarketDataConfig;
};

export class MarketDataConfigStore {
  readonly dataHome: string;

  constructor(dataHome: string) {
    this.dataHome = dataHome;
  }

  load(): Result<MarketDataConfig> {
    if (this.needsLockedPreparation()) {
      return withBookLock(this.dataHome, () => this.loadUnlocked());
    }
    return this.loadUnlocked();
  }

  inspect(): Result<MarketDataConfigInspection> {
    try {
      const path = join(this.dataHome, CONFIG_FILE);
      if (!existsSync(path)) return succeed({ exists: false, config: defaultMarketDataConfig() });
      const parsed = MarketDataConfigSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      return parsed.success
        ? succeed({ exists: true, config: parsed.data })
        : fail(validationError(parsed.error.message));
    } catch (error) {
      return fail(storageError(error instanceof Error ? error.message : "unknown config error"));
    }
  }

  save(config: MarketDataConfig): Result<void> {
    const parsed = MarketDataConfigSchema.safeParse(config);
    if (!parsed.success) return fail(validationError(parsed.error.message));
    return withBookLock(this.dataHome, () => this.saveUnlocked(parsed.data));
  }

  update(transform: (config: MarketDataConfig) => MarketDataConfig): Result<MarketDataConfig> {
    return withBookLock(this.dataHome, () => {
      const current = this.loadUnlocked();
      if (!current.ok) return fail(current.error);
      const next = transform(current.data);
      const parsed = MarketDataConfigSchema.safeParse(next);
      if (!parsed.success) return fail(validationError(parsed.error.message));
      const saved = this.saveUnlocked(parsed.data);
      return saved.ok ? succeed(parsed.data) : fail(saved.error);
    });
  }

  private loadUnlocked(): Result<MarketDataConfig> {
    try {
      this.ensureDirectory();
      const path = join(this.dataHome, CONFIG_FILE);
      if (!existsSync(path)) {
        const config = defaultMarketDataConfig();
        this.write(config);
        return succeed(config);
      }
      this.setOwnerOnly(path);
      const value = JSON.parse(readFileSync(path, "utf8"));
      const parsed = MarketDataConfigSchema.safeParse(value);
      return parsed.success ? succeed(parsed.data) : fail(validationError(parsed.error.message));
    } catch (error) {
      return fail(storageError(error instanceof Error ? error.message : "unknown config error"));
    }
  }

  private saveUnlocked(config: MarketDataConfig): Result<void> {
    try {
      this.ensureDirectory();
      this.write(config);
      return succeed(undefined);
    } catch (error) {
      return fail(storageError(error instanceof Error ? error.message : "unknown config error"));
    }
  }

  private ensureDirectory(): void {
    mkdirSync(this.dataHome, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(this.dataHome, 0o700);
  }

  private needsLockedPreparation(): boolean {
    try {
      const path = join(this.dataHome, CONFIG_FILE);
      if (!existsSync(this.dataHome) || !existsSync(path)) return true;
      if (process.platform === "win32") return false;
      return (
        (statSync(this.dataHome).mode & 0o777) !== 0o700 || (statSync(path).mode & 0o777) !== 0o600
      );
    } catch {
      return true;
    }
  }

  private write(config: MarketDataConfig): void {
    const target = join(this.dataHome, CONFIG_FILE);
    const temporary = join(
      this.dataHome,
      `.${basename(CONFIG_FILE)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      if (process.platform !== "win32") chmodSync(temporary, 0o600);
      renameSync(temporary, target);
      if (process.platform !== "win32") chmodSync(target, 0o600);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  private setOwnerOnly(path: string): void {
    if (process.platform !== "win32") chmodSync(path, 0o600);
  }
}

function validationError(detail: string): DomainError {
  return {
    type: "validation",
    message: `Invalid market-data configuration: ${detail}.`,
    hint: "Fix market-data.json or use the config command.",
  };
}

function storageError(detail: string): DomainError {
  return {
    type: "storage",
    message: `Could not access market-data configuration: ${detail}.`,
    hint: "Check FINBOOK_HOME and market-data.json.",
  };
}
