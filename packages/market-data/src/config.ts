import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import { fail, succeed, type DomainError, type Result } from "@finbook/core";

import {
  MarketDataConfigSchema,
  type MarketDataConfig,
  type ProviderId,
  type RouteKey,
  type SourceBinding,
} from "./contracts.js";

const CONFIG_FILE = "market-data.json";

const DEFAULT_ROUTES = {
  "price:stock": ["yahoo"],
  "price:etf": ["yahoo"],
  "price:fund": ["yahoo"],
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
  return configured.filter((provider) => !config.disabledProviders.includes(provider));
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

export class MarketDataConfigStore {
  readonly dataHome: string;

  constructor(dataHome: string) {
    this.dataHome = dataHome;
  }

  load(): Result<MarketDataConfig> {
    try {
      this.ensureDirectory();
      const path = join(this.dataHome, CONFIG_FILE);
      if (!existsSync(path)) {
        const config = defaultMarketDataConfig();
        this.write(config);
        return succeed(config);
      }
      const value = JSON.parse(readFileSync(path, "utf8"));
      const parsed = MarketDataConfigSchema.safeParse(value);
      return parsed.success ? succeed(parsed.data) : fail(validationError(parsed.error.message));
    } catch (error) {
      return fail(storageError(error instanceof Error ? error.message : "unknown config error"));
    }
  }

  save(config: MarketDataConfig): Result<void> {
    const parsed = MarketDataConfigSchema.safeParse(config);
    if (!parsed.success) return fail(validationError(parsed.error.message));
    try {
      this.ensureDirectory();
      this.write(parsed.data);
      return succeed(undefined);
    } catch (error) {
      return fail(storageError(error instanceof Error ? error.message : "unknown config error"));
    }
  }

  private ensureDirectory(): void {
    mkdirSync(this.dataHome, { recursive: true, mode: 0o700 });
  }

  private write(config: MarketDataConfig): void {
    const target = join(this.dataHome, CONFIG_FILE);
    const temporary = join(this.dataHome, `.${basename(CONFIG_FILE)}.${process.pid}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      chmodSync(temporary, 0o600);
      renameSync(temporary, target);
      chmodSync(target, 0o600);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
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
