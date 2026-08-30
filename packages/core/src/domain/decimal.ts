import { Decimal } from "decimal.js";

export const DecimalMath = Decimal.clone({
  precision: 100,
  rounding: Decimal.ROUND_HALF_UP,
});

export const CALCULATION_DECIMAL_PLACES = 18;

export function calculatedDecimal(value: InstanceType<typeof DecimalMath>): string {
  const fixed = value.toFixed(CALCULATION_DECIMAL_PLACES);
  if (!fixed.includes(".")) return fixed;
  return fixed.replace(/0+$/u, "").replace(/\.$/u, "");
}

export function canonicalDecimal(value: string): string {
  return new DecimalMath(value).toFixed();
}
