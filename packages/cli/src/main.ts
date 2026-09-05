#!/usr/bin/env node

import { CommanderError } from "commander";
import { FileBookStore } from "@finbook/core";
import {
  CoinGeckoSource,
  EcbSource,
  MarketDataConfigStore,
  MarketDataCoordinator,
  YahooSource,
} from "@finbook/market-data";

import { CliFailure, requireResult, validationFailure } from "./errors.js";
import { loadRuntimeConfig } from "./environment.js";
import { writeError } from "./output.js";
import { createProgram } from "./program.js";
import { assertSupportedNodeVersion } from "./runtime.js";

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<number> {
  const json = argv.includes("--json");

  try {
    assertSupportedNodeVersion();
    const dataHome = resolveDataHome(argv, env, cwd);
    const marketData = () => {
      const config = requireResult(new MarketDataConfigStore(dataHome).load());
      const ecb = new EcbSource();
      const yahoo = new YahooSource();
      const coingecko = new CoinGeckoSource({
        demoApiKey: env.FINBOOK_COINGECKO_DEMO_API_KEY,
      });
      return new MarketDataCoordinator({
        store: new FileBookStore(dataHome),
        config,
        priceSources: [yahoo, coingecko],
        fxSources: [ecb, coingecko],
        eurRateSources: [ecb, coingecko],
      });
    };
    const program = createProgram(dataHome, { marketDataFactory: marketData });
    if (argv.length === 0) {
      program.outputHelp();
      return 0;
    }
    if (argv.length === 1 && argv[0] === "--json") {
      throw validationFailure(
        "A command is required when using `--json`.",
        "Provide a command or remove --json to see help.",
      );
    }
    await program.parseAsync([process.execPath, "finbook", ...argv]);
    return 0;
  } catch (error) {
    if (error instanceof CliFailure) {
      writeError(error.domainError, json, error.externalDetails);
      return error.exitCode;
    }
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
        return 0;
      }
      const message = error.message.replace(/^error: /u, "");
      writeError(
        {
          type: "validation",
          message: `${message}.`,
          hint: "Run `finbook --help` to see the available commands and flags.",
        },
        json,
      );
      return 2;
    }
    if (error instanceof Error) {
      writeError(
        {
          type: "internal",
          message: error.message,
          hint: "Run the command again; if it persists, report the command and runtime.",
        },
        json,
      );
      return 1;
    }
    writeError(
      {
        type: "internal",
        message: "Unexpected error.",
        hint: "Run the command again; if it persists, report the command and runtime.",
      },
      json,
    );
    return 1;
  }
}

function resolveDataHome(argv: readonly string[], env: NodeJS.ProcessEnv, cwd: string): string {
  if (canRunWithoutDataHome(argv)) return cwd;
  try {
    return loadRuntimeConfig(env, cwd).dataHome;
  } catch (error) {
    throw validationFailure(
      error instanceof Error ? error.message : "Invalid FINBOOK_HOME.",
      "Set FINBOOK_HOME to a writable path outside the checkout.",
    );
  }
}

function canRunWithoutDataHome(argv: readonly string[]): boolean {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--json")) return true;
  for (const arg of argv) {
    if (arg === "--") return false;
    if (arg === "--help" || arg === "-h" || arg === "--version" || arg === "-V") return true;
  }
  return false;
}

process.exitCode = await main();
