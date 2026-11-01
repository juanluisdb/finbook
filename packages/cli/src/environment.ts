import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { isManagedProviderHome } from "@finbook/market-data";

const ProvidersHomeSchema = z.string().trim().min(1).optional();

const DataHomeSchema = z.string().trim().min(1).default("~/.finbook");

export type RuntimeConfig = {
  dataHome: string;
};

export function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): RuntimeConfig {
  const parsed = DataHomeSchema.safeParse(env.FINBOOK_HOME);
  if (!parsed.success) {
    throw new Error("FINBOOK_HOME must not be empty.");
  }
  const rawDataHome = parsed.data;

  const dataHome =
    rawDataHome === "~/.finbook" ? resolve(homedir(), ".finbook") : resolve(cwd, rawDataHome);

  const checkout = fileURLToPath(new URL("../../../", import.meta.url));
  const canonicalBook = canonicalPath(dataHome);
  if (isWithin(canonicalPath(checkout), canonicalBook)) {
    throw new Error(`FINBOOK_HOME must be outside the checkout; received ${dataHome}.`);
  }

  const configuredProviders = ProvidersHomeSchema.safeParse(env.FINBOOK_PROVIDERS_HOME);
  if (configuredProviders.success) {
    const code = providerPath(configuredProviders.data, cwd);
    let canonicalCode = code;
    try {
      canonicalCode = canonicalPath(code);
    } catch {
      /* An unusable provider directory must not block a separate offline book. */
    }
    if (isWithin(canonicalCode, canonicalBook) || isWithin(canonicalBook, canonicalCode)) {
      throw new Error(
        "FINBOOK_HOME and FINBOOK_PROVIDERS_HOME must be separate, non-overlapping directories.",
      );
    }
  }
  for (let parent = canonicalBook; ; parent = dirname(parent)) {
    if (isManagedProviderHome(parent))
      throw new Error("FINBOOK_HOME must be separate from managed provider code.");
    if (dirname(parent) === parent) break;
  }
  return { dataHome };
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(canonicalPath(parent), basename(path));
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

export function loadProvidersHome(env: NodeJS.ProcessEnv, cwd: string): string {
  return providerPath(ProvidersHomeSchema.parse(env.FINBOOK_PROVIDERS_HOME), cwd);
}

function providerPath(configured: string | undefined, cwd: string): string {
  return configured === undefined
    ? join(homedir(), ".local", "share", "finbook", "providers")
    : resolve(cwd, configured);
}
