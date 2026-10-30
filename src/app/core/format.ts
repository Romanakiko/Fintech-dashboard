import { type CentsDecimal, centsToDollars } from './money';

export const UNAVAILABLE = '—';

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const imbalance = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: 'exceptZero',
});
const quantity = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** "$101.50". Rounds once, half-even, from exact cents. */
export function formatMoney(cents: number | CentsDecimal | null): string {
  if (cents === null) {
    return UNAVAILABLE;
  }
  // A decimal string keeps Intl from converting the amount to a float.
  return currency.format(centsToDollars(cents) as Intl.StringNumericLiteral);
}

/** "+0.20", "-0.35", "0.00". */
export function formatImbalance(value: number | null): string {
  return value === null ? UNAVAILABLE : imbalance.format(value);
}

/** "1,234". */
export function formatQuantity(value: number | null): string {
  return value === null ? UNAVAILABLE : quantity.format(value);
}
