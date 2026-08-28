import { z } from "zod";

import { DecimalMath } from "./decimal.js";

const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const CURRENCY_PATTERN = /^[A-Z][A-Z0-9-]{2,9}$/u;
const ACCOUNT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const INSTRUMENT_ID_PATTERN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

export const DecimalStringSchema = z
  .string()
  .regex(DECIMAL_PATTERN, "Expected a plain decimal string")
  .transform((value) => new DecimalMath(value).toFixed());

export const PositiveDecimalStringSchema = DecimalStringSchema.refine(
  (value) => new DecimalMath(value).greaterThan(0),
  "Expected a positive decimal",
);

export const NonNegativeDecimalStringSchema = DecimalStringSchema.refine(
  (value) => new DecimalMath(value).greaterThanOrEqualTo(0),
  "Expected a non-negative decimal",
);

export const CurrencySchema = z
  .string()
  .regex(CURRENCY_PATTERN, "Expected an uppercase currency code");

export const AccountIdSchema = z
  .string()
  .min(1)
  .regex(ACCOUNT_ID_PATTERN, "Expected a lowercase account slug");

export const InstrumentIdSchema = z
  .string()
  .min(1)
  .regex(INSTRUMENT_ID_PATTERN, "Expected an instrument slug");

export const IsoDateSchema = z
  .string()
  .regex(ISO_DATE_PATTERN, "Expected an ISO date (YYYY-MM-DD)")
  .refine(isCalendarDate, "Expected a real calendar date");

export const CountryCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}$/u, "Expected an uppercase ISO country code");

export const NonEmptyStringSchema = z.string().min(1);

function isCalendarDate(value: string): boolean {
  const match = ISO_DATE_PATTERN.exec(value);
  const monthText = match?.[2];
  const dayText = match?.[3];
  const yearText = match?.[1];

  if (yearText === undefined || monthText === undefined || dayText === undefined) return false;

  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (month < 1 || month > 12 || day < 1) return false;

  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth =
    month === 2 ? (isLeapYear ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return day <= daysInMonth;
}
