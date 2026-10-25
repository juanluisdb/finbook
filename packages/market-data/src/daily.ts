import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  FxStampSchema,
  IsoDateSchema,
  IsoInstantSchema,
  PriceStampSchema,
  fail,
  succeed,
  withBookLock,
  type BookSnapshot,
  type Result,
} from "@finbook/core";

const ResolutionSchema = z
  .object({
    key: z.string().min(1),
    cycle: IsoDateSchema,
    checkedAt: IsoInstantSchema,
    observation: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("price"), mark: PriceStampSchema }).strict(),
      z.object({ kind: z.literal("fx"), mark: FxStampSchema }).strict(),
    ]),
  })
  .strict();
type Resolution = z.infer<typeof ResolutionSchema>;

export function dailyCycle(now: Date): string {
  return new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function dailyTarget(asOf: string, crypto: boolean, now: Date): string {
  const cycle = dailyCycle(now);
  const limit = crypto
    ? cycle
    : new Date(Date.parse(`${cycle}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return asOf < limit ? asOf : limit;
}

export class DailyResolutions {
  private readonly home: string;

  constructor(home: string) {
    this.home = home;
  }

  load(): Result<readonly Resolution[]> {
    const path = join(this.home, "market-refresh.jsonl");
    return withBookLock(this.home, () => {
      try {
        if (!existsSync(path)) return succeed([]);
        const lines = readFileSync(path, "utf8").split(/\r?\n/u);
        if (lines.at(-1) === "") lines.pop();
        return succeed(lines.map((line) => ResolutionSchema.parse(JSON.parse(line))));
      } catch {
        return fail({
          type: "storage",
          message: "Could not read daily refresh records.",
          hint: "Inspect market-refresh.jsonl in FINBOOK_HOME.",
        });
      }
    });
  }

  save(resolution: Resolution): Result<void> {
    const parsed = ResolutionSchema.safeParse(resolution);
    if (!parsed.success) throw new Error("Invalid internal refresh resolution.");
    return withBookLock(this.home, () => {
      try {
        const path = join(this.home, "market-refresh.jsonl");
        writeFileSync(path, `${JSON.stringify(parsed.data)}\n`, { flag: "a", mode: 0o600 });
        if (process.platform !== "win32") chmodSync(path, 0o600);
        return succeed(undefined);
      } catch {
        return fail({
          type: "storage",
          message: "Could not save the daily refresh record; its observation may already be saved.",
          hint: "Check FINBOOK_HOME permissions and retry.",
        });
      }
    });
  }
}

export function cachedResolution(
  records: readonly Resolution[],
  key: string,
  cycle: string,
  target: string,
  snapshot: BookSnapshot,
): Resolution | undefined {
  return records.findLast((record) => {
    if (record.key !== key || (record.cycle !== cycle && record.observation.mark.asOf !== target))
      return false;
    const observation = record.observation;
    return observation.kind === "price"
      ? snapshot.prices.some((mark) => isDeepStrictEqual(mark, observation.mark))
      : snapshot.fx.some((mark) => isDeepStrictEqual(mark, observation.mark));
  });
}
