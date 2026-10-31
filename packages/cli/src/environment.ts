import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

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
  if (isWithin(canonicalPath(checkout), canonicalPath(dataHome))) {
    throw new Error(`FINBOOK_HOME must be outside the checkout; received ${dataHome}.`);
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
