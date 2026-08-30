import { calculatedDecimal, DecimalMath } from "./decimal.js";
import type { Money } from "./schemas.js";

export class CurrencyMismatchError extends Error {
  constructor(leftCurrency: string, rightCurrency: string) {
    super(`Cannot combine different currencies: ${leftCurrency} and ${rightCurrency}`);
    this.name = "CurrencyMismatchError";
  }
}

export class MoneyValue {
  readonly amount: InstanceType<typeof DecimalMath>;
  readonly currency: string;

  private constructor(amount: InstanceType<typeof DecimalMath>, currency: string) {
    this.amount = amount;
    this.currency = currency;
  }

  static from(money: Money): MoneyValue {
    return new MoneyValue(new DecimalMath(money.amount), money.currency);
  }

  static zero(currency: string): MoneyValue {
    return new MoneyValue(new DecimalMath(0), currency);
  }

  add(other: MoneyValue): MoneyValue {
    this.requireSameCurrency(other);
    return new MoneyValue(this.amount.plus(other.amount), this.currency);
  }

  subtract(other: MoneyValue): MoneyValue {
    this.requireSameCurrency(other);
    return new MoneyValue(this.amount.minus(other.amount), this.currency);
  }

  multiply(factor: string): MoneyValue {
    return new MoneyValue(this.amount.times(new DecimalMath(factor)), this.currency);
  }

  divide(divisor: string): MoneyValue {
    const quotient = this.amount.dividedBy(new DecimalMath(divisor));
    return new MoneyValue(new DecimalMath(calculatedDecimal(quotient)), this.currency);
  }

  isNegative(): boolean {
    return this.amount.isNegative();
  }

  isZero(): boolean {
    return this.amount.isZero();
  }

  greaterThan(other: MoneyValue): boolean {
    this.requireSameCurrency(other);
    return this.amount.greaterThan(other.amount);
  }

  greaterThanOrEqualTo(other: MoneyValue): boolean {
    this.requireSameCurrency(other);
    return this.amount.greaterThanOrEqualTo(other.amount);
  }

  toMoney(): Money {
    return { amount: this.amount.toFixed(), currency: this.currency };
  }

  private requireSameCurrency(other: MoneyValue): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
