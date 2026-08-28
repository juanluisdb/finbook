import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const cliPath = resolve(repositoryRoot, "packages/cli/dist/main.js");

describe("finbook doctor", () => {
  it("reports an empty temporary book as JSON", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "finbook-doctor-"));

    try {
      const result = spawnSync(process.execPath, [cliPath, "doctor", "--json"], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { ...process.env, FINBOOK_HOME: dataHome },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        ok: true,
        data: {
          schemaVersion: 1,
          eventCount: 0,
          holeCount: 0,
          dataPath: resolve(dataHome),
        },
      });
    } finally {
      rmSync(dataHome, { recursive: true, force: true });
    }
  });
});
