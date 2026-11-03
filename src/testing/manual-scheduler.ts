import type { Scheduler } from '../app/producer/worker/producer-engine';

/** Runs ticks only when the test calls fire(). */
export class ManualScheduler implements Scheduler {
  intervalMs: number | null = null;
  private tick: ((late: boolean) => void) | null = null;

  get running(): boolean {
    return this.tick !== null;
  }

  start(intervalMs: number, tick: (late: boolean) => void): void {
    this.intervalMs = intervalMs;
    this.tick = tick;
  }

  stop(): void {
    this.intervalMs = null;
    this.tick = null;
  }

  fire(late = false): void {
    if (this.tick === null) {
      throw new Error('The scheduler is not running');
    }
    this.tick(late);
  }
}
