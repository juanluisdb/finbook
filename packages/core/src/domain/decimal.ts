import { Decimal } from "decimal.js";

export const DecimalMath = Decimal.clone({
  precision: 100,
  rounding: Decimal.ROUND_HALF_UP,
});

export function canonicalDecimal(value: string): string {
  return new DecimalMath(value).toFixed();
}
