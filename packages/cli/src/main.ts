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

import { currentDate } from "./dates.js";
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
    const runtimeConfig = loadRuntimeConfig(env, cwd);
    const marketData = () => {
      const config = requireResult(new MarketDataConfigStore(runtimeConfig.dataHome).load());
      const ecb = new EcbSource();
      const yahoo = new YahooSource();
      const coingecko = new CoinGeckoSource({
        demoApiKey: env.FINBOOK_COINGECKO_DEMO_API_KEY,
      });
      return new MarketDataCoordinator({
        store: new FileBookStore(runtimeConfig.dataHome),
        config,
        priceSources: [yahoo, coingecko],
        fxSources: [ecb, coingecko],
        eurRateSources: [ecb, coingecko],
      });
    };
    const program = createProgram(runtimeConfig.dataHome, currentDate(), undefined, marketData);
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

process.exitCode = await main();
