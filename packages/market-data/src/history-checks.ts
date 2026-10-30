import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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
import { ProviderIdSchema } from "./contracts.js";

const HistoryObservationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("price"), mark: PriceStampSchema }).strict(),
  z.object({ kind: z.literal("fx"), mark: FxStampSchema }).strict(),
]);
export type HistoryObservation = z.infer<typeof HistoryObservationSchema>;

const HistoryCheckSchema = z
  .object({
    key: z.string().min(1),
    from: IsoDateSchema,
    through: IsoDateSchema,
    checkedAt: IsoInstantSchema,
    provider: ProviderIdSchema,
    observations: z.array(HistoryObservationSchema),
  })
  .strict()
  .refine((value) => value.from <= value.through);
export type HistoryCheck = z.infer<typeof HistoryCheckSchema>;

export class HistoryChecks {
  private readonly home: string;
  constructor(home: string) {
    this.home = home;
  }

  load(): Result<readonly HistoryCheck[]> {
    return withBookLock(this.home, () => {
      const path = join(this.home, "market-history.jsonl");
      try {
        if (!existsSync(path)) return succeed([]);
        const lines = readFileSync(path, "utf8").split(/\r?\n/u);
        if (lines.at(-1) === "") lines.pop();
        return succeed(lines.map((line) => HistoryCheckSchema.parse(JSON.parse(line))));
      } catch {
        return fail({
          type: "storage",
          message: "Could not read historical market checks.",
          hint: "Inspect market-history.jsonl in FINBOOK_HOME.",
        });
      }
    });
  }

  save(check: HistoryCheck): Result<void> {
    const parsed = HistoryCheckSchema.safeParse(check);
    if (!parsed.success) throw new Error("Invalid internal historical market check.");
    return withBookLock(this.home, () => {
      try {
        const path = join(this.home, "market-history.jsonl");
        writeFileSync(path, `${JSON.stringify(parsed.data)}\n`, { flag: "a", mode: 0o600 });
        if (process.platform !== "win32") chmodSync(path, 0o600);
        return succeed(undefined);
      } catch {
        return fail({
          type: "storage",
          message: "Could not save the historical market check; observations may already be saved.",
          hint: "Check FINBOOK_HOME permissions and retry.",
        });
      }
    });
  }
}

export function checkIsIntact(check: HistoryCheck, snapshot: BookSnapshot): boolean {
  return check.observations.every((observation) =>
    observation.kind === "price"
      ? snapshot.prices.some((mark) => isDeepStrictEqual(mark, observation.mark))
      : snapshot.fx.some((mark) => isDeepStrictEqual(mark, observation.mark)),
  );
}
