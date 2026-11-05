import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { MarketStore } from '../../state/market.store';
import { axeViolations } from '../../../testing/axe';
import { TestProducer } from '../../../testing/test-producer';
import { DashboardPage } from './dashboard.page';

describe('DashboardPage', () => {
  let producer: TestProducer;
  let store: MarketStore;
  let fixture: ComponentFixture<DashboardPage>;
  let element: HTMLElement;

  const toggle = () => element.querySelector<HTMLButtonElement>('app-producer-controls button');
  const summary = (term: string) =>
    [...element.querySelectorAll('.summary div')]
      .find((item) => item.querySelector('dt')?.textContent?.trim() === term)
      ?.querySelector('dd')
      ?.textContent?.replace(/\s+/g, ' ')
      .trim();
  /** What a screen reader announces for each cell of the first row. */
  const firstRow = () =>
    [...element.querySelectorAll('tbody tr:first-child td')].map((cell) => {
      const spoken = cell.cloneNode(true) as Element;
      spoken.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => hidden.remove());
      return spoken.textContent?.replace(/\s+/g, ' ').trim();
    });

  beforeEach(async () => {
    producer = new TestProducer();
    TestBed.configureTestingModule({ providers: producer.providers });
    store = TestBed.inject(MarketStore);
    fixture = TestBed.createComponent(DashboardPage);
    element = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
  });

  it('shows every instrument as unavailable, with zero volume, before any data', () => {
    expect(element.querySelectorAll('tbody tr')).toHaveLength(5);
    expect(firstRow()).toEqual([
      'not available',
      'not available',
      '0',
      'not available',
      'not available',
    ]);
  });

  it('cannot pause or resume while the producer is starting', () => {
    store.connect();

    expect(toggle()?.disabled).toBe(true);
  });

  it('cannot pause or resume after the producer has failed', async () => {
    producer.boot(store);
    producer.worker.emit({
      type: 'error',
      runId: 1,
      code: 'GENERATION_FAILED',
      message: 'unreachable',
      fatal: true,
    });
    await fixture.whenStable();

    expect(toggle()?.disabled).toBe(true);
  });

  it('shows the latest snapshot and the run summary', async () => {
    producer.boot(store);
    producer.publishWorkedExample(store);
    await fixture.whenStable();

    expect(firstRow()).toEqual(['$102.00', '$0.04', '40', '$101.50', '+0.20']);
    expect(summary('Instruments')).toBe('5');
    expect(summary('Batches')).toBe('100 updates every 500 ms');
    expect(summary('Updates this run')).toBe('1,234');
    expect(summary('Effective rate')).toBe('200 updates/s');
  });

  it('pauses and resumes, following the state the worker confirms', async () => {
    producer.boot(store);
    await fixture.whenStable();
    expect(toggle()?.textContent?.trim()).toBe('Pause');

    toggle()?.click();
    expect(producer.worker.posted.at(-1)).toEqual({ type: 'pause', runId: 1 });
    producer.worker.emit({ type: 'status', runId: 1, state: 'paused' });
    await fixture.whenStable();
    expect(toggle()?.textContent?.trim()).toBe('Resume');
    expect(summary('Effective rate')).toBe('0 updates/s');

    toggle()?.click();
    expect(producer.worker.posted.at(-1)).toEqual({ type: 'resume', runId: 1 });
  });

  it('keeps the values while paused, but not the rate it measured while running', async () => {
    producer.boot(store);
    producer.publishWorkedExample(store);
    await fixture.whenStable();
    expect(summary('Effective rate')).toBe('200 updates/s');

    producer.worker.emit({ type: 'status', runId: 1, state: 'paused' });
    await fixture.whenStable();

    expect(summary('Effective rate')).toBe('0 updates/s');

    expect(firstRow()[2]).toBe('40');
  });

  it('has no accessibility violations', async () => {
    producer.boot(store);
    producer.publishWorkedExample(store);
    await fixture.whenStable();

    expect(await axeViolations(element)).toEqual([]);
  });
});
