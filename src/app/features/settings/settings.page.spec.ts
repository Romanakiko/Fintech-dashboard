import { signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { form } from '@angular/forms/signals';
import {
  DEFAULT_SETTINGS,
  SETTINGS_LIMITS,
  type SettingKey,
  validateSetting,
} from '../../core/settings';
import { MarketStore } from '../../state/market.store';
import { axeViolations } from '../../../testing/axe';
import { TestProducer } from '../../../testing/test-producer';
import { type SettingsDraft, SettingsPage, settingsSchema } from './settings.page';

const KEYS = Object.keys(SETTINGS_LIMITS) as SettingKey[];

describe('SettingsPage', () => {
  let producer: TestProducer;
  let store: MarketStore;
  let fixture: ComponentFixture<SettingsPage>;
  let element: HTMLElement;

  const input = (key: SettingKey) => element.querySelector<HTMLInputElement>(`#${key}`);
  const error = (key: SettingKey) =>
    element.querySelector(`#${key}-error`)?.textContent?.trim() ?? null;
  const button = (label: string) =>
    [...element.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
  const confirmation = () => element.querySelector('[role="status"]')?.textContent?.trim();
  const values = () => KEYS.map((key) => input(key)?.value);

  async function type(key: SettingKey, text: string): Promise<void> {
    const field = input(key);
    if (field === null) {
      throw new Error(`No input for ${key}`);
    }
    field.value = text;
    field.dispatchEvent(new Event('input'));
    await fixture.whenStable();
  }

  async function apply(): Promise<void> {
    button('Apply')?.click();
    await fixture.whenStable();
  }

  beforeEach(async () => {
    producer = new TestProducer();
    TestBed.configureTestingModule({ providers: producer.providers });
    store = TestBed.inject(MarketStore);
    producer.boot(store);
    fixture = TestBed.createComponent(SettingsPage);
    element = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
  });

  it('starts from the settings of the active run', () => {
    expect(values()).toEqual(['5', '100', '500']);
  });

  describe('validation', () => {
    it.each([
      ['instrumentCount', '', 'Enter the instrument count.'],
      ['instrumentCount', '2.5', 'Instrument count must be a whole number.'],
      ['instrumentCount', '0', 'Instrument count must be 1 or more.'],
      ['instrumentCount', '51', 'Instrument count must be 50 or less.'],
      ['updatesPerBatch', '1001', 'Updates per batch must be 1,000 or less.'],
      ['batchIntervalMs', '49', 'Batch interval (ms) must be 50 or more.'],
      ['batchIntervalMs', '2001', 'Batch interval (ms) must be 2,000 or less.'],
    ] as const)('explains %s = "%s" as soon as it is edited', async (key, text, message) => {
      await type(key, text);

      expect(error(key)).toBe(message);
      expect(input(key)?.getAttribute('aria-invalid')).toBe('true');
      expect(input(key)?.getAttribute('aria-describedby')).toBe(`${key}-hint ${key}-error`);
      expect(button('Apply')?.disabled).toBe(true);
    });

    it('accepts both ends of every range', async () => {
      for (const key of KEYS) {
        await type(key, String(SETTINGS_LIMITS[key].min));
        expect(error(key)).toBeNull();
        await type(key, String(SETTINGS_LIMITS[key].max));
        expect(error(key)).toBeNull();
      }
      expect(button('Apply')?.disabled).toBe(false);
    });

    it('accepts exactly what the producer accepts', () => {
      const draft = signal<SettingsDraft>({ ...DEFAULT_SETTINGS });
      const settingsForm = TestBed.runInInjectionContext(() => form(draft, settingsSchema));

      for (const key of KEYS) {
        const { min, max } = SETTINGS_LIMITS[key];
        for (const value of [min - 1, min, min + 0.5, max, max + 1, null, NaN]) {
          draft.set({ ...DEFAULT_SETTINGS, [key]: value });
          expect([key, value, settingsForm[key]().valid()]).toEqual([
            key,
            value,
            validateSetting(key, value) === null,
          ]);
        }
      }
    });
  });

  it('does not touch the producer while editing', async () => {
    await type('instrumentCount', '3');
    await type('updatesPerBatch', '10');

    expect(producer.sent('start')).toHaveLength(1); // The boot run only.
    expect(store.settings()).toEqual(DEFAULT_SETTINGS);
  });

  it('applies the settings as a new run that starts from empty totals', async () => {
    producer.publishWorkedExample(store);
    await type('instrumentCount', '3');
    await type('updatesPerBatch', '10');
    await type('batchIntervalMs', '50');

    await apply();

    const next = { instrumentCount: 3, updatesPerBatch: 10, batchIntervalMs: 50 };
    expect(producer.sent('start').at(-1)).toMatchObject({ runId: 2, settings: next });
    expect(store.settings()).toEqual(next);
    expect(store.rows()).toHaveLength(3);
    expect(store.rows().every((row) => row.volume === 0 && row.vwapCents === null)).toBe(true);
    expect(confirmation()).toBe(
      'Applied. Run 2 started with 3 instruments and 10 updates every 50 ms.',
    );
  });

  it('confirms every Apply, even of unchanged settings, with the new run number', async () => {
    await apply();
    expect(confirmation()).toBe(
      'Applied. Run 2 started with 5 instruments and 100 updates every 500 ms.',
    );

    await apply();
    expect(confirmation()).toBe(
      'Applied. Run 3 started with 5 instruments and 100 updates every 500 ms.',
    );
  });

  it('does not claim a run started while the producer is recovering', async () => {
    producer.worker.emit({
      type: 'error',
      runId: 1,
      code: 'GENERATION_FAILED',
      message: 'unreachable',
      fatal: true,
    });

    await apply();

    expect(store.status()).toBe('initializing');
    expect(confirmation()).toBe(
      'Applied. A new run with 5 instruments and 100 updates every 500 ms starts once the producer is ready.',
    );
  });

  it('ignores a submitted form that is invalid', async () => {
    await type('instrumentCount', '0');
    const submit = new Event('submit', { bubbles: true, cancelable: true });
    element.querySelector('form')?.dispatchEvent(submit);
    await fixture.whenStable();

    expect(submit.defaultPrevented).toBe(true);
    expect(producer.sent('start')).toHaveLength(1);
    expect(confirmation()).toBe('');
  });

  it('starts generating on Apply even when the run is paused', async () => {
    producer.worker.emit({ type: 'status', runId: 1, state: 'paused' });

    await apply();

    expect(store.status()).toBe('running');
    expect(producer.sent('start')).toHaveLength(2);
  });

  it('hides the confirmation once the form is edited again', async () => {
    await apply();
    expect(confirmation()).toContain('Applied.');

    await type('instrumentCount', '7');
    expect(confirmation()).toBe('');
  });

  it('restores the defaults without applying them', async () => {
    await type('instrumentCount', '9');
    button('Reset to defaults')?.click();
    await fixture.whenStable();

    expect(values()).toEqual(['5', '100', '500']);
    expect(producer.sent('start')).toHaveLength(1);
  });

  it('has no accessibility violations, with or without errors', async () => {
    expect(await axeViolations(element)).toEqual([]);

    await type('instrumentCount', '0');
    expect(await axeViolations(element)).toEqual([]);
  });
});
