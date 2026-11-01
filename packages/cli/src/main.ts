#!/usr/bin/env node

import { CommanderError } from "commander";
import { z } from "zod";
import { FileBookStore } from "@finbook/core";
import {
  MarketDataConfigStore,
  MarketDataCoordinator,
  ProviderPackages,
  ProviderRuntime,
} from "@finbook/market-data";

import { CliFailure, requireResult, validationFailure } from "./errors.js";
import { loadProvidersHome, loadRuntimeConfig } from "./environment.js";
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
    const providerPackages = () => {
      try {
        return new ProviderPackages(loadProvidersHome(env, cwd), env);
      } catch {
        throw validationFailure(
          "Invalid FINBOOK_PROVIDERS_HOME.",
          "Use a nonempty path for the separate provider installation directory.",
        );
      }
    };
    const marketData = () => {
      const config = requireResult(new MarketDataConfigStore(dataHome).load());
      const parsedEnvironment = z.record(z.string(), z.string().optional()).parse({ ...env });
      const environment = Object.fromEntries(
        Object.entries(parsedEnvironment).flatMap(([key, value]) =>
          value === undefined ? [] : [[key, value]],
        ),
      );
      const runtime = new ProviderRuntime(providerPackages, environment);
      const sources = runtime.sources(config);
      return new MarketDataCoordinator({
        store: new FileBookStore(dataHome),
        config,
        eurRateSources: sources,
        eurRateSource: (id) => runtime.source(id),
        priceHistorySources: sources,
        fxHistorySources: sources,
        withProviderSession: (operation) => runtime.withSession(operation),
      });
    };
    const program = createProgram(dataHome, {
      marketDataFactory: marketData,
      providerPackagesFactory: providerPackages,
      cwd,
    });
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
      writeError(error.domainError, json);
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
  if (canRunWithoutDataHome(argv) || argv.filter((arg) => arg !== "--json")[0] === "provider")
    return cwd;
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
