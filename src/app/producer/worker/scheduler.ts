import type { Scheduler } from './producer-engine';

/**
 * A setTimeout scheduler that keeps ticks on a fixed grid (start + k × interval), so
 * timer and tick latency do not accumulate as drift.
 *
 * A tick that fires more than one interval late re-anchors the grid at the current time
 * instead of firing the missed ticks back to back. A slow thread therefore never causes
 * a catch-up burst.
 */
export class TimerScheduler implements Scheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private intervalMs = 0;
  private dueAt = 0;
  private onTick: (late: boolean) => void = () => undefined;

  constructor(private readonly now: () => number) {}

  start(intervalMs: number, tick: (late: boolean) => void): void {
    this.stop();
    this.intervalMs = intervalMs;
    this.onTick = tick;
    this.dueAt = this.now() + intervalMs;
    this.arm();
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(): void {
    this.timer = setTimeout(() => this.fire(), Math.max(0, this.dueAt - this.now()));
  }

  private fire(): void {
    const now = this.now();
    const late = now - this.dueAt > this.intervalMs;
    this.dueAt = late ? now + this.intervalMs : this.dueAt + this.intervalMs;
    // Re-arm first so the tick can stop or replace the schedule.
    this.arm();
    this.onTick(late);
  }
}
