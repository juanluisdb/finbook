import { execFile } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { fail, inspectLock, succeed, withFileLock, type Result } from "@finbook/core";
import {
  ProviderMetadataSchema,
  ProviderModuleSchema,
  type ProviderModule,
  type ProviderMetadata,
} from "@finbook/provider-sdk";

const execute = promisify(execFile);
const PackageNameSchema = z.string().regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u);
const ManifestSchema = z.object({
  name: z.literal("finbook-providers"),
  private: z.literal(true),
  dependencies: z.record(PackageNameSchema, z.string()).default({}),
});
const PackageSchema = z.object({
  name: PackageNameSchema,
  version: z.string().min(1),
  finbook: ProviderMetadataSchema,
});
const BridgeSchema = z.object({
  resolveEntry: z.function({ input: [z.string()], output: z.string() }),
  load: z.function({ input: [z.string()], output: z.promise(z.unknown()) }),
});
const LOCK = ".finbook.providers.lock";
const BRIDGE =
  "export const resolveEntry = (name) => import.meta.resolve(name);\nexport const load = (name) => import(name);\n";
export type InstalledProvider = { package: string; version: string; metadata: ProviderMetadata };
export type ProviderListing = {
  providers: InstalledProvider[];
  problems: { package: string; message: string }[];
};

export class ProviderPackages {
  readonly home: string;
  private readonly environment: NodeJS.ProcessEnv;
  constructor(home: string, environment: NodeJS.ProcessEnv) {
    this.home = home;
    this.environment = environment;
  }

  async withSession<T>(operation: () => Promise<Result<T>>): Promise<Result<T>> {
    const allowed = this.checkDirectory();
    return allowed.ok ? withFileLock(this.home, LOCK, operation) : allowed;
  }

  async list(): Promise<Result<ProviderListing>> {
    const inspection = inspectLock(this.home, LOCK);
    if (inspection.kind !== "absent")
      return fail({
        type: "storage",
        message: `Provider code at ${this.home} is busy or locked.`,
        hint:
          inspection.kind === "active"
            ? "Retry after the active operation finishes."
            : `Stop provider work, inspect ${join(this.home, LOCK)}, and remove it only after confirming no process uses this provider directory.`,
      });
    return this.catalog();
  }

  async catalog(): Promise<Result<ProviderListing>> {
    try {
      if (!existsSync(join(this.home, "package.json"))) {
        const allowed = this.checkDirectory();
        return allowed.ok ? succeed({ providers: [], problems: [] }) : allowed;
      }
      const manifest = this.manifest();
      const providers: InstalledProvider[] = [];
      const problems: ProviderListing["problems"] = [];
      for (const name of Object.keys(manifest.dependencies).sort()) {
        try {
          const installed = PackageSchema.parse(
            JSON.parse(readFileSync(join(this.home, "node_modules", name, "package.json"), "utf8")),
          );
          if (installed.name !== name)
            throw new Error("Installed package identity differs from its selection.");
          const bridge = await this.bridge();
          const entry = z.string().parse(bridge.resolveEntry(name));
          if (!existsSync(fileURLToPath(entry)))
            throw new Error("The public entry is missing; build and re-add the package.");
          if (providers.some((provider) => provider.metadata.id === installed.finbook.id)) {
            problems.push({
              package: name,
              message: `Duplicate provider ID ${installed.finbook.id}. Remove one conflicting package.`,
            });
            const previous = providers.find(
              (provider) => provider.metadata.id === installed.finbook.id,
            );
            if (previous !== undefined)
              problems.push({
                package: previous.package,
                message: `Duplicate provider ID ${installed.finbook.id}. Remove one conflicting package.`,
              });
          }
          providers.push({
            package: name,
            version: installed.version,
            metadata: installed.finbook,
          });
        } catch {
          problems.push({
            package: name,
            message:
              "Invalid provider declaration or unavailable public entry. Inspect the package and reinstall it.",
          });
        }
      }
      return succeed({
        providers: providers.filter(
          (provider) => !problems.some((problem) => problem.package === provider.package),
        ),
        problems,
      });
    } catch {
      return packageFailure("Could not inspect the managed provider directory.");
    }
  }

  async find(id: string): Promise<Result<InstalledProvider>> {
    const listed = await this.catalog();
    if (!listed.ok) return listed;
    const provider = listed.data.providers.find((value) => value.metadata.id === id);
    return provider === undefined
      ? fail({
          type: "external",
          message: `Provider ${id} is not installed or has an invalid declaration.`,
          hint: "Use `finbook provider list`, reinstall its package, or select an installed provider.",
        })
      : succeed(provider);
  }

  async load(name: string): Promise<ProviderModule> {
    const bridge = await this.bridge();
    return ProviderModuleSchema.parse(await bridge.load(bridge.resolveEntry(name)));
  }

  async add(input: string, cwd: string): Promise<Result<InstalledProvider>> {
    const local = isAbsolute(input) || input.startsWith(".");
    let name: string;
    let spec = input;
    let explicit = local;
    try {
      if (local) {
        spec = resolve(cwd, input);
        const description = PackageSchema.parse(
          JSON.parse(readFileSync(join(spec, "package.json"), "utf8")),
        );
        name = description.name;
      } else {
        const parsed =
          /^(?<name>(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@(?<version>[a-zA-Z0-9][a-zA-Z0-9._+-]*))?$/u.exec(
            input,
          );
        name = PackageNameSchema.parse(parsed?.groups?.name);
        explicit = parsed?.groups?.version !== undefined;
      }
    } catch {
      return fail({
        type: "validation",
        message: "Invalid provider package or local directory.",
        hint: "Use a package name, name@version-or-tag, or a built local package directory with finbook metadata.",
      });
    }
    return this.withSession(async () => {
      let temporary: string | undefined;
      try {
        this.prepare();
        const dependencies = this.manifest().dependencies;
        const existing = Object.hasOwn(dependencies, name);
        if (existing && !explicit) return this.installed(name);
        if (local) {
          temporary = mkdtempSync(join(tmpdir(), "finbook-provider-pack-"));
          const packed = await this.npm(
            ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary],
            spec,
          );
          const output = z
            .array(z.object({ filename: z.string() }))
            .length(1)
            .parse(JSON.parse(packed));
          const filename = output[0]?.filename;
          if (filename === undefined) throw new Error("Package tool omitted artifact.");
          const packedPath = join(temporary, filename);
          const artifactHome = join(this.home, "local-packages", name);
          mkdirSync(artifactHome, { recursive: true });
          spec = join(artifactHome, "package.tgz");
          // npm otherwise reuses a same-version local package instead of replacing edited code.
          if (existing) await this.npm(["uninstall", "--ignore-scripts", name]);
          copyFileSync(packedPath, spec);
        }
        await this.npm(["install", "--save-exact", "--ignore-scripts", spec]);
        return this.installed(name);
      } catch {
        return packageFailure(
          `Could not install provider package ${name}. Provider code may have changed; book data is untouched.`,
        );
      } finally {
        if (temporary !== undefined) rmSync(temporary, { recursive: true, force: true });
      }
    });
  }

  async remove(name: string): Promise<Result<{ package: string }>> {
    const parsed = PackageNameSchema.safeParse(name);
    if (!parsed.success)
      return fail({
        type: "validation",
        message: "Invalid package name.",
        hint: "Use a package name from `finbook provider list`.",
      });
    return this.withSession(async () => {
      try {
        this.prepare();
        if (!Object.hasOwn(this.manifest().dependencies, parsed.data))
          return fail({
            type: "not-found",
            message: `Package ${name} is not installed.`,
            hint: "Use `finbook provider list`.",
          });
        await this.npm(["uninstall", "--ignore-scripts", parsed.data]);
        rmSync(join(this.home, "local-packages", parsed.data), { recursive: true, force: true });
        return succeed({ package: parsed.data });
      } catch {
        return packageFailure(
          `Could not remove provider package ${name}. Provider code may have changed; book data is untouched.`,
        );
      }
    });
  }

  private async installed(name: string): Promise<Result<InstalledProvider>> {
    const listed = await this.catalog();
    if (!listed.ok) return listed;
    const installed = listed.data.providers.find((provider) => provider.package === name);
    return installed === undefined
      ? packageFailure(
          `Installed package ${name} has invalid or conflicting provider metadata or a missing public entry.`,
        )
      : succeed(installed);
  }

  private checkDirectory(): Result<void> {
    try {
      if (!existsSync(this.home)) return succeed(undefined);
      if (existsSync(join(this.home, "package.json"))) this.manifest();
      else if (readdirSync(this.home).some((entry) => entry !== LOCK))
        return packageFailure("The provider directory contains unrelated files.");
      return succeed(undefined);
    } catch {
      return packageFailure(
        "The provider directory is not a readable finbook-managed installation.",
      );
    }
  }

  private manifest() {
    return ManifestSchema.parse(JSON.parse(readFileSync(join(this.home, "package.json"), "utf8")));
  }

  private prepare(): void {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const path = join(this.home, "package.json");
    if (!existsSync(path)) {
      // A lock alone is not evidence that an unrelated directory belongs to finbook.
      if (readdirSync(this.home).some((entry) => entry !== LOCK))
        throw new Error("Unmanaged provider directory.");
      writeFileSync(
        path,
        JSON.stringify({ name: "finbook-providers", private: true, dependencies: {} }, null, 2) +
          "\n",
        { mode: 0o600 },
      );
    }
    this.manifest();
    writeFileSync(join(this.home, "load-provider.mjs"), BRIDGE, { mode: 0o600 });
  }

  private async bridge() {
    return BridgeSchema.parse(
      await import(pathToFileURL(join(this.home, "load-provider.mjs")).href),
    );
  }

  private async npm(args: string[], cwd = this.home): Promise<string> {
    const result = await execute("npm", [...args, "--no-audit", "--no-fund", "--loglevel=error"], {
      cwd,
      env: this.environment,
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout;
  }
}

function packageFailure(message: string): Result<never> {
  return fail({
    type: "external",
    message,
    hint: "Inspect `finbook provider list`, check npm availability and package access, then reinstall. Package-tool output is withheld to protect credentials.",
  });
}
