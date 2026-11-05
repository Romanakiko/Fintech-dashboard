import { Component, DOCUMENT, Injector, afterNextRender, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { ErrorBanner } from './layout/error-banner';
import { focusMainHeading } from './layout/focus-main';
import { ProducerStatusBadge } from './layout/producer-status';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ErrorBanner, ProducerStatusBadge],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly document = inject(DOCUMENT);

  constructor() {
    const injector = inject(Injector);
    // After a client-side navigation, move focus to the new page's heading, as a full page
    // load would, so keyboard and screen reader users start at the new content. The initial
    // navigation (id 1) keeps the browser's default focus, even if it failed and a later
    // navigation is the first to succeed.
    inject(Router)
      .events.pipe(
        filter((event) => event instanceof NavigationEnd && event.id > 1),
        takeUntilDestroyed(),
      )
      .subscribe(() => afterNextRender(() => focusMainHeading(this.document), { injector }));
  }

  /** A plain `#main` link would resolve against `<base href>` and reload the app. */
  protected skipToMain(event: Event): void {
    event.preventDefault();
    focusMainHeading(this.document);
  }
}
