import { Component, computed, inject, signal } from '@angular/core';
import {
  FormField,
  FormRoot,
  type ValidationError,
  form,
  max,
  min,
  required,
  schema,
  validate,
} from '@angular/forms/signals';
import { formatQuantity } from '../../core/format';
import {
  DEFAULT_SETTINGS,
  SETTINGS_LIMITS,
  type SettingKey,
  isValidSettings,
} from '../../core/settings';
import { MarketStore } from '../../state/market.store';

/** What the form holds while editing: an emptied number input is null. */
export type SettingsDraft = Record<SettingKey, number | null>;

interface SettingField {
  readonly key: SettingKey;
  readonly label: string;
  readonly hint: string;
}

const FIELDS: readonly SettingField[] = [
  {
    key: 'instrumentCount',
    label: 'Instrument count',
    hint: 'How many fictional instruments to generate data for.',
  },
  {
    key: 'updatesPerBatch',
    label: 'Updates per batch',
    hint: 'Market updates in each batch, across all instruments.',
  },
  {
    key: 'batchIntervalMs',
    label: 'Batch interval (ms)',
    hint: 'Requested time between batches, in milliseconds.',
  },
];

/**
 * The limits come from SETTINGS_LIMITS, the same table the worker validates against, so the
 * form cannot accept settings the producer would reject. Built-in rules are used (rather
 * than one custom rule) because they also set the native required/min/max attributes.
 */
export const settingsSchema = schema<SettingsDraft>((path) => {
  for (const { key, label } of FIELDS) {
    const limits = SETTINGS_LIMITS[key];
    required(path[key], { message: `Enter the ${label.toLowerCase()}.` });
    validate(path[key], ({ value }) => {
      const current = value();
      return current === null || Number.isNaN(current) || Number.isInteger(current)
        ? null
        : { kind: 'integer', message: `${label} must be a whole number.` };
    });
    min(path[key], limits.min, {
      message: `${label} must be ${formatQuantity(limits.min)} or more.`,
    });
    max(path[key], limits.max, {
      message: `${label} must be ${formatQuantity(limits.max)} or less.`,
    });
  }
});

/**
 * Edits a local draft. Nothing reaches the producer until Apply, which starts a new run.
 * Leaving the page discards an unapplied draft; coming back shows the applied settings.
 */
@Component({
  selector: 'app-settings-page',
  imports: [FormField, FormRoot],
  templateUrl: './settings.page.html',
  styleUrl: './settings.page.scss',
})
export class SettingsPage {
  private readonly market = inject(MarketStore);
  private readonly appliedMessage = signal('');

  protected readonly fields = FIELDS;
  protected readonly limits = SETTINGS_LIMITS;
  protected readonly quantity = formatQuantity;
  protected readonly draft = signal<SettingsDraft>({ ...this.market.settings() });
  protected readonly settingsForm = form(this.draft, settingsSchema, {
    submission: { action: async () => this.apply() },
  });

  /** Shown after Apply until the next edit, and announced by its live region. */
  protected readonly confirmation = computed(() =>
    this.settingsForm().dirty() ? '' : this.appliedMessage(),
  );

  protected errorText(field: SettingField, errors: readonly ValidationError[]): string {
    // A native parse error (such as "1e") carries no message of its own.
    return errors[0]?.message ?? `${field.label} must be a number.`;
  }

  protected resetToDefaults(): void {
    this.settingsForm().reset({ ...DEFAULT_SETTINGS });
    this.appliedMessage.set('');
  }

  private apply(): void {
    const settings = this.draft();
    // Submission only runs when the form is valid; this narrows the draft's nulls away.
    if (!isValidSettings(settings)) {
      return;
    }
    this.market.startRun(settings);
    this.settingsForm().reset();

    const { instrumentCount, updatesPerBatch, batchIntervalMs } = settings;
    const described =
      `${instrumentCount} instruments and ${formatQuantity(updatesPerBatch)} updates ` +
      `every ${formatQuantity(batchIntervalMs)} ms`;
    // The run number makes re-applying the same settings visibly (and audibly) new. While
    // the producer is starting or recovering, the run has not started yet, so say so.
    this.appliedMessage.set(
      this.market.status() === 'running'
        ? `Applied. Run ${this.market.runId()} started with ${described}.`
        : `Applied. A new run with ${described} starts once the producer is ready.`,
    );
  }
}
