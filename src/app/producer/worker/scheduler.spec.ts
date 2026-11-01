import { TimerScheduler } from './scheduler';

describe('TimerScheduler', () => {
  let scheduler: TimerScheduler;
  let ticks: { at: number; late: boolean }[];
  const record = (late: boolean) => ticks.push({ at: Date.now(), late });

  // vi.setSystemTime shifts the clock and pending timers together, so it simulates a
  // thread that was busy when a timer was due.
  const block = (ms: number) => vi.setSystemTime(Date.now() + ms);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    scheduler = new TimerScheduler(() => Date.now());
    ticks = [];
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  it('first ticks one interval after start, then every interval', () => {
    scheduler.start(100, record);
    vi.advanceTimersByTime(99);
    expect(ticks).toEqual([]);

    vi.advanceTimersByTime(201);
    expect(ticks).toEqual([
      { at: 100, late: false },
      { at: 200, late: false },
      { at: 300, late: false },
    ]);
  });

  it('compensates a slightly late tick to stay on the grid', () => {
    scheduler.start(100, record);
    block(30);
    vi.advanceTimersByTime(100); // fires at 130 instead of 100
    vi.advanceTimersByTime(70);

    expect(ticks).toEqual([
      { at: 130, late: false },
      { at: 200, late: false },
    ]);
  });

  it('re-anchors after falling more than one interval behind, without a burst', () => {
    scheduler.start(100, record);
    block(250);
    vi.advanceTimersByTime(100); // fires at 350: ticks at 100..300 were missed
    vi.advanceTimersByTime(99);
    expect(ticks).toEqual([{ at: 350, late: true }]);

    vi.advanceTimersByTime(1);
    expect(ticks).toEqual([
      { at: 350, late: true },
      { at: 450, late: false },
    ]);
  });

  it('stops ticking after stop()', () => {
    scheduler.start(100, record);
    vi.advanceTimersByTime(100);
    scheduler.stop();
    vi.advanceTimersByTime(1000);

    expect(ticks).toHaveLength(1);
  });

  it('lets a tick stop the schedule', () => {
    scheduler.start(100, () => {
      record(false);
      scheduler.stop();
    });
    vi.advanceTimersByTime(1000);

    expect(ticks).toHaveLength(1);
  });

  it('replaces a running schedule on start()', () => {
    const replaced = vi.fn();
    scheduler.start(100, replaced);
    vi.advanceTimersByTime(50);
    scheduler.start(500, record);
    vi.advanceTimersByTime(1000);

    expect(replaced).not.toHaveBeenCalled();
    expect(ticks.map((tick) => tick.at)).toEqual([550, 1050]);
  });
});
