import { Component, InjectionToken, inject } from '@angular/core';

// Replaced at build time: empty by default (angular.json `define`), and the deployed commit
// and time when scripts/render-build.sh passes `--define`.
declare const BUILD_COMMIT: string;
declare const BUILD_TIME: string;

/** The commit this bundle was built from and the UTC build time (ISO 8601). */
export interface BuildInfo {
  readonly commit: string;
  readonly builtAt: string;
}

export const BUILD_INFO = new InjectionToken<BuildInfo>('BUILD_INFO', {
  factory: () => ({ commit: BUILD_COMMIT, builtAt: BUILD_TIME }),
});

/** Shows which commit is live, so anyone can check that a deploy went out. */
@Component({
  selector: 'app-build-info',
  template: `
    <p class="build-info">
      @if (commit && builtAt) {
        Commit {{ commit }}, built <time [attr.datetime]="builtAt">{{ builtAtLabel }}</time>
      } @else {
        Local build
      }
    </p>
  `,
  styles: `
    .build-info {
      margin: 0;
      font-size: 0.875rem;
      color: var(--color-text-muted);
    }
  `,
})
export class BuildInfoLine {
  private readonly info = inject(BUILD_INFO);

  /** Seven characters, like `git rev-parse --short HEAD`. */
  protected readonly commit = this.info.commit.slice(0, 7);
  protected readonly builtAt = this.info.builtAt;
  /** `2026-11-09T16:05:12Z` → `2026-11-09 16:05 UTC`. */
  protected readonly builtAtLabel = `${this.builtAt.slice(0, 10)} ${this.builtAt.slice(11, 16)} UTC`;
}
