import { type ComponentFixture, TestBed } from '@angular/core/testing';
import type { ProducerEvent } from '../core/protocol';
import { MarketStore } from '../state/market.store';
import { axeViolations } from '../../testing/axe';
import { TestProducer } from '../../testing/test-producer';
import { ErrorBanner } from './error-banner';

const FETCH_FAILED: ProducerEvent = {
  type: 'error',
  runId: null,
  code: 'WASM_FETCH_FAILED',
  message: 'Could not fetch /wasm/market_gen.wasm: HTTP 404',
  fatal: true,
};

describe('ErrorBanner', () => {
  let producer: TestProducer;
  let store: MarketStore;
  let fixture: ComponentFixture<ErrorBanner>;
  let element: HTMLElement;

  const alert = () => element.querySelector('[role="alert"]');
  const retry = () => element.querySelector<HTMLButtonElement>('button');

  beforeEach(async () => {
    producer = new TestProducer();
    TestBed.configureTestingModule({ providers: producer.providers });
    store = TestBed.inject(MarketStore);
    store.connect();
    fixture = TestBed.createComponent(ErrorBanner);
    element = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
  });

  it('shows nothing while there is no error', () => {
    expect(alert()).toBeNull();
  });

  it('explains an initialization failure and offers Retry', async () => {
    producer.worker.emit(FETCH_FAILED);
    await fixture.whenStable();

    const lines = [...(alert()?.children ?? [])].map((line) => line.textContent?.trim());
    expect(lines).toEqual([
      'The market data generator could not be downloaded.',
      'Could not fetch /wasm/market_gen.wasm: HTTP 404 (WASM_FETCH_FAILED)',
      'Retry',
    ]);
  });

  it('retries with a new producer', async () => {
    producer.worker.emit(FETCH_FAILED);
    await fixture.whenStable();

    retry()?.click();
    await fixture.whenStable();

    expect(producer.workers).toHaveLength(2);
    expect(store.status()).toBe('initializing');
    expect(alert()).toBeNull();
  });

  it('does not offer Retry for an error the producer survived', async () => {
    producer.boot(store);
    producer.worker.emit({
      type: 'error',
      runId: null,
      code: 'INVALID_COMMAND',
      message: 'Rejected a malformed command',
      fatal: false,
    });
    await fixture.whenStable();

    expect(alert()?.textContent).toContain('The producer rejected a command.');
    expect(retry()).toBeNull();
  });

  it('has no accessibility violations', async () => {
    producer.worker.emit(FETCH_FAILED);
    await fixture.whenStable();

    expect(await axeViolations(element)).toEqual([]);
  });
});
