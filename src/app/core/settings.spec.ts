import {
  DEFAULT_SETTINGS,
  SETTINGS_LIMITS,
  type SettingKey,
  isValidSettings,
  validateSetting,
} from './settings';

const KEYS = Object.keys(SETTINGS_LIMITS) as SettingKey[];

describe('settings', () => {
  it('uses the specified defaults', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      instrumentCount: 5,
      updatesPerBatch: 100,
      batchIntervalMs: 500,
    });
    expect(isValidSettings(DEFAULT_SETTINGS)).toBe(true);
  });

  it('uses the specified ranges', () => {
    expect(SETTINGS_LIMITS).toEqual({
      instrumentCount: { min: 1, max: 50 },
      updatesPerBatch: { min: 1, max: 1000 },
      batchIntervalMs: { min: 50, max: 2000 },
    });
  });

  describe.each(KEYS)('validateSetting(%s)', (key) => {
    const { min, max } = SETTINGS_LIMITS[key];

    it('accepts both inclusive bounds', () => {
      expect(validateSetting(key, min)).toBeNull();
      expect(validateSetting(key, max)).toBeNull();
    });

    it('rejects values just outside the range', () => {
      expect(validateSetting(key, min - 1)).toEqual({ kind: 'min', min });
      expect(validateSetting(key, max + 1)).toEqual({ kind: 'max', max });
    });

    it('rejects non-integers', () => {
      expect(validateSetting(key, min + 0.5)).toEqual({ kind: 'integer' });
      expect(validateSetting(key, Infinity)).toEqual({ kind: 'integer' });
    });

    it.each([null, undefined, NaN, '', '10'])('treats %j as missing', (value) => {
      expect(validateSetting(key, value)).toEqual({ kind: 'required' });
    });
  });

  describe('isValidSettings', () => {
    it('rejects non-objects and incomplete objects', () => {
      expect(isValidSettings(null)).toBe(false);
      expect(isValidSettings('settings')).toBe(false);
      expect(isValidSettings({ instrumentCount: 5, updatesPerBatch: 100 })).toBe(false);
    });

    it('rejects an object with any invalid field', () => {
      expect(isValidSettings({ ...DEFAULT_SETTINGS, batchIntervalMs: 49 })).toBe(false);
      expect(isValidSettings({ ...DEFAULT_SETTINGS, instrumentCount: 2.5 })).toBe(false);
    });
  });
});
