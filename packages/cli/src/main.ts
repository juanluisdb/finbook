#!/usr/bin/env node

import { loadRuntimeConfig } from "./environment.js";
import { createEmptyDoctor } from "./doctor.js";
import { assertSupportedNodeVersion } from "./runtime.js";

export function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): number {
  assertSupportedNodeVersion();
  const runtimeConfig = loadRuntimeConfig(env, cwd);

  if (argv[0] !== "doctor") {
    process.stderr.write("finbook scaffold currently supports only `doctor`.\n");
    return 2;
  }

  const data = createEmptyDoctor(runtimeConfig.dataHome);
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
  } else {
    process.stdout.write(
      [
        `schema version: ${data.schemaVersion}`,
        `events: ${data.eventCount}`,
        `holes: ${data.holeCount}`,
        `data path: ${data.dataPath}`,
      ].join("\n") + "\n",
    );
  }

  return 0;
}

process.exitCode = main();
