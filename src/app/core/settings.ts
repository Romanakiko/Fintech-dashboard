/** Producer configuration; a new run starts whenever it is applied. */
export interface ProducerSettings {
  readonly instrumentCount: number;
  readonly updatesPerBatch: number;
  readonly batchIntervalMs: number;
}

export type SettingKey = keyof ProducerSettings;

export interface SettingLimits {
  readonly min: number;
  readonly max: number;
}

/** Inclusive integer ranges, mirrored by MAX_INSTRUMENTS / MAX_BATCH in the Wasm crate. */
export const SETTINGS_LIMITS: Readonly<Record<SettingKey, SettingLimits>> = {
  instrumentCount: { min: 1, max: 50 },
  updatesPerBatch: { min: 1, max: 1000 },
  batchIntervalMs: { min: 50, max: 2000 },
};

export const DEFAULT_SETTINGS: ProducerSettings = {
  instrumentCount: 5,
  updatesPerBatch: 100,
  batchIntervalMs: 500,
};

export type SettingError =
  | { readonly kind: 'required' }
  | { readonly kind: 'integer' }
  | { readonly kind: 'min'; readonly min: number }
  | { readonly kind: 'max'; readonly max: number };

export function validateSetting(key: SettingKey, value: unknown): SettingError | null {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return { kind: 'required' };
  }
  if (!Number.isInteger(value)) {
    return { kind: 'integer' };
  }
  const { min, max } = SETTINGS_LIMITS[key];
  if (value < min) {
    return { kind: 'min', min };
  }
  if (value > max) {
    return { kind: 'max', max };
  }
  return null;
}

const SETTING_KEYS = Object.keys(SETTINGS_LIMITS) as readonly SettingKey[];

/** Runtime guard used wherever settings cross a trust boundary (e.g. into the worker). */
export function isValidSettings(value: unknown): value is ProducerSettings {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return SETTING_KEYS.every((key) => validateSetting(key, record[key]) === null);
}
