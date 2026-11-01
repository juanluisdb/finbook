import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ProviderPackages } from "../packages/market-data/dist/index.js";

const destination = process.argv[2];
if (!destination) throw new Error("Provide a new provider directory outside the checkout.");
const home = resolve(destination);
if (existsSync(home) && readdirSync(home).length !== 0)
  throw new Error(
    "Use an empty directory; this source-build helper does not update an existing installation.",
  );
const repository = resolve(import.meta.dirname, "..");
const packages = new ProviderPackages(home, process.env);
const result = await packages.withSession(async () => {
  const artifacts = join(home, "artifacts");
  mkdirSync(artifacts);
  const overrides = {};
  for (const name of [
    "core",
    "provider-sdk",
    "market-data",
    "cli",
    "provider-yahoo",
    "provider-eodhd",
    "provider-ecb",
    "provider-coingecko",
  ]) {
    execFileSync(
      "corepack",
      [
        "pnpm",
        "--config.verifyDepsBeforeRun=false",
        "--config.ignore-scripts=true",
        "--filter",
        `@finbook/${name}`,
        "pack",
        "--pack-destination",
        artifacts,
      ],
      { cwd: repository, stdio: "pipe" },
    );
    const metadata = JSON.parse(
      readFileSync(join(repository, "packages", name, "package.json"), "utf8"),
    );
    const archive = join(artifacts, `finbook-${name}-${metadata.version}.tgz`);
    if (["core", "provider-sdk", "market-data"].includes(name))
      overrides[`@finbook/${name}`] = `file:${archive}`;
    if (name.startsWith("provider-") && name !== "provider-sdk") {
      const source = join(home, "sources", name);
      mkdirSync(source, { recursive: true });
      execFileSync("tar", ["-xf", archive, "--strip-components=1", "-C", source]);
    }
  }
  writeFileSync(
    join(home, "package.json"),
    JSON.stringify(
      { name: "finbook-providers", private: true, dependencies: {}, overrides },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  return { ok: true, data: undefined };
});
if (!result.ok) throw new Error(result.error.message);
console.log(
  `Prepared local provider sources in ${join(home, "sources")}. Add only the packages you need with finbook provider add.`,
);
