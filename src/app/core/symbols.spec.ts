import { SETTINGS_LIMITS } from './settings';
import { SYMBOLS, symbolOf } from './symbols';

describe('symbols', () => {
  it('provides a unique four-letter symbol for every possible instrument', () => {
    expect(SYMBOLS.length).toBeGreaterThanOrEqual(SETTINGS_LIMITS.instrumentCount.max);
    expect(new Set(SYMBOLS).size).toBe(SYMBOLS.length);
    for (const symbol of SYMBOLS) {
      expect(symbol).toMatch(/^[A-Z]{4}$/);
    }
  });

  it('maps instrument indexes to symbols', () => {
    expect(symbolOf(0)).toBe('ALFA');
    expect(symbolOf(1)).toBe('BETA');
    expect(() => symbolOf(SYMBOLS.length)).toThrow(RangeError);
  });
});
