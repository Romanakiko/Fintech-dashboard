import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { MarketStore } from './state/market.store';
import { axeViolations } from '../testing/axe';
import { TestProducer } from '../testing/test-producer';
import { App } from './app';
import { appConfig } from './app.config';

describe('App', () => {
  let producer: TestProducer;
  let store: MarketStore;
  let router: Router;
  let fixture: ComponentFixture<App>;
  let element: HTMLElement;

  async function navigate(url: string): Promise<void> {
    await router.navigateByUrl(url);
    await fixture.whenStable();
  }

  const heading = () => element.querySelector('h1');
  const pauseButton = () =>
    element.querySelector<HTMLButtonElement>('app-producer-controls button');

  beforeEach(async () => {
    producer = new TestProducer();
    TestBed.configureTestingModule({ providers: [...appConfig.providers, ...producer.providers] });
    fixture = TestBed.createComponent(App);
    element = fixture.nativeElement as HTMLElement;
    store = TestBed.inject(MarketStore);
    router = TestBed.inject(Router);
    producer.boot(store);
    await navigate('/');
  });

  it('opens the dashboard for the empty path and for unknown paths', async () => {
    expect(router.url).toBe('/dashboard');
    expect(heading()?.textContent).toBe('Market dashboard');

    await navigate('/no-such-page');
    expect(router.url).toBe('/dashboard');
  });

  it('titles each page and marks it as current in the navigation', async () => {
    await navigate('/settings');

    expect(document.title).toBe('Settings – Realtime Fintech Dashboard');
    expect(element.querySelector('[aria-current="page"]')?.textContent?.trim()).toBe('Settings');
  });

  it('keeps one producer, the run and its paused state across navigation', async () => {
    pauseButton()?.click();
    producer.worker.emit({ type: 'status', runId: 1, state: 'paused' });

    await navigate('/settings');
    await navigate('/dashboard');

    expect(producer.workers).toHaveLength(1);
    expect(producer.worker.posted.map((command) => command.type)).toEqual([
      'load',
      'start',
      'pause',
    ]);
    expect(store.runId()).toBe(1);
    expect(pauseButton()?.textContent?.trim()).toBe('Resume');
  });

  it('moves focus to the new page heading after navigating', async () => {
    await navigate('/settings');

    expect(document.activeElement).toBe(heading());
    expect(heading()?.textContent).toBe('Producer settings');
  });

  it('leaves focus where the browser put it on the first load', () => {
    expect(document.activeElement).toBe(document.body);
  });

  it('keeps keyboard focus on the page when Retry removes the error banner', async () => {
    producer.worker.emit({
      type: 'error',
      runId: 1,
      code: 'GENERATION_FAILED',
      message: 'unreachable',
      fatal: true,
    });
    await fixture.whenStable();
    const retry = [...element.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Retry',
    );
    retry?.focus();

    retry?.click();
    await fixture.whenStable();

    expect(element.querySelector('[role="alert"]')).toBeNull();
    expect(document.activeElement).toBe(heading());
  });

  it('skips to the main content without reloading the app', () => {
    const skipLink = element.querySelector<HTMLAnchorElement>('.skip-link');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    skipLink?.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(heading());
  });

  it.each(['/dashboard', '/settings'])(
    'has no accessibility violations on %s, landmarks included',
    async (url) => {
      await navigate(url);

      expect(await axeViolations(element, { region: { enabled: true } })).toEqual([]);
    },
  );
});
