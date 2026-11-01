import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function installFixtureProviders(home: string): void {
  mkdirSync(join(home, "node_modules", "@finbook"), { recursive: true });
  const dependencies: Record<string, string> = {};
  for (const name of ["yahoo", "eodhd", "ecb", "coingecko"]) {
    const source = resolve(import.meta.dirname, `../packages/provider-${name}`);
    const metadata = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    dependencies[metadata.name] = metadata.version;
    symlinkSync(source, join(home, "node_modules", "@finbook", `provider-${name}`), "dir");
  }
  writeFileSync(
    join(home, "package.json"),
    JSON.stringify({ name: "finbook-providers", private: true, dependencies }),
  );
  writeFileSync(
    join(home, "load-provider.mjs"),
    "export const resolveEntry = name => import.meta.resolve(name); export const load = name => import(name);",
  );
}
