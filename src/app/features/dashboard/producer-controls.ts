import { Component, computed, inject } from '@angular/core';
import { MarketStore } from '../../state/market.store';

/**
 * One button whose label says what it will do. It deliberately has no `aria-pressed`: a
 * toggle whose label also changes would be announced as "Resume, pressed", which misleads.
 */
@Component({
  selector: 'app-producer-controls',
  template: `
    <button type="button" class="button" [disabled]="!canToggle()" (click)="toggle()">
      {{ paused() ? 'Resume' : 'Pause' }}
    </button>
  `,
})
export class ProducerControls {
  private readonly market = inject(MarketStore);

  protected readonly paused = computed(() => this.market.status() === 'paused');
  /** Only a running or paused run can be toggled; not while starting or failed. */
  protected readonly canToggle = computed(
    () => this.paused() || this.market.status() === 'running',
  );

  protected toggle(): void {
    if (this.paused()) {
      this.market.resume();
    } else {
      this.market.pause();
    }
  }
}
