import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function canonicalBookHome(dataHome: string, checkout: string): string {
  const canonicalBook = canonicalPath(dataHome);
  if (isWithin(canonicalPath(checkout), canonicalBook)) {
    throw new Error(`FINBOOK_HOME must be outside the checkout; received ${dataHome}.`);
  }
  return canonicalBook;
}

export function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(canonicalPath(parent), basename(path));
  }
}

export function isWithin(parent: string, candidate: string): boolean {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}
