import { Decimal } from 'decimal.js';

/**
 * The only module that touches decimal.js. Money values arrive as integer
 * cents (or an exact bigint notional) and leave as decimal strings, so binary
 * floating point never holds a fractional amount.
 *
 * A private constructor keeps the global Decimal config untouched. 40
 * significant digits leave far more headroom than the quotients here need
 * (≤ 13 integer digits over a volume < 10^15), so the single display rounding
 * below is not affected by the division's internal rounding.
 */
const Money = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

/** Decimal string of cents, e.g. "10150" or "10150.333…". */
export type CentsDecimal = string;

/** Volume-weighted average price in cents, unrounded; null when nothing has traded. */
export function vwapCents(notionalCents: bigint, volume: number): CentsDecimal | null {
  if (volume === 0) {
    return null;
  }
  return new Money(notionalCents.toString()).div(volume).toFixed();
}

/** Dollars rounded half-even to whole cents, e.g. 10150.5 -> "101.50". */
export function centsToDollars(cents: number | CentsDecimal): string {
  return new Money(cents).div(100).toFixed(2, Money.ROUND_HALF_EVEN);
}
