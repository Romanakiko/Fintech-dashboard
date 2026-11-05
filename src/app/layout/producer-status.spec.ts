import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { MarketStore } from '../state/market.store';
import { TestProducer } from '../../testing/test-producer';
import { ProducerStatusBadge } from './producer-status';

describe('ProducerStatusBadge', () => {
  let producer: TestProducer;
  let store: MarketStore;
  let fixture: ComponentFixture<ProducerStatusBadge>;

  const text = () =>
    (fixture.nativeElement as HTMLElement)
      .querySelector('[role="status"]')
      ?.textContent?.replace(/\s+/g, ' ')
      .trim();

  beforeEach(async () => {
    producer = new TestProducer();
    TestBed.configureTestingModule({ providers: producer.providers });
    store = TestBed.inject(MarketStore);
    fixture = TestBed.createComponent(ProducerStatusBadge);
    await fixture.whenStable();
  });

  it('reports each lifecycle state in a live region, with the run', async () => {
    expect(text()).toBe('Producer: Starting');

    producer.boot(store);
    await fixture.whenStable();
    expect(text()).toBe('Producer: Running · run 1');

    producer.worker.emit({ type: 'status', runId: 1, state: 'paused' });
    await fixture.whenStable();
    expect(text()).toBe('Producer: Paused · run 1');

    producer.worker.emit({
      type: 'error',
      runId: 1,
      code: 'GENERATION_FAILED',
      message: 'unreachable',
      fatal: true,
    });
    await fixture.whenStable();
    expect(text()).toBe('Producer: Stopped · run 1');
  });
});
