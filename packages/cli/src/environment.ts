import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type RuntimeConfig = {
  dataHome: string;
};

export function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): RuntimeConfig {
  const configuredHome = env.FINBOOK_HOME;
  const rawDataHome = configuredHome === undefined ? "~/.finbook" : configuredHome.trim();

  if (rawDataHome.length === 0) {
    throw new Error("FINBOOK_HOME must not be empty.");
  }

  const dataHome =
    rawDataHome === "~/.finbook" ? resolve(homedir(), ".finbook") : resolve(cwd, rawDataHome);

  if (isWithin(cwd, dataHome)) {
    throw new Error(`FINBOOK_HOME must be outside the checkout; received ${dataHome}.`);
  }

  return { dataHome };
}

function isWithin(parent: string, candidate: string): boolean {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}
