import { TestBed } from '@angular/core/testing';
import { axeViolations } from '../../testing/axe';
import { BUILD_INFO, BuildInfoLine } from './build-info';

describe('BuildInfoLine', () => {
  async function render(): Promise<HTMLElement> {
    const fixture = TestBed.createComponent(BuildInfoLine);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  const text = (element: HTMLElement) => element.textContent?.replace(/\s+/g, ' ').trim();

  it('says "Local build" without the deploy metadata (angular.json defaults)', async () => {
    expect(text(await render())).toBe('Local build');
  });

  it('shows the short commit and the UTC build time of a deployed build', async () => {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: BUILD_INFO,
          useValue: {
            commit: '0123abcdef4567890123abcdef4567890123abcd',
            builtAt: '2026-11-09T16:05:12Z',
          },
        },
      ],
    });
    const element = await render();

    expect(text(element)).toBe('Commit 0123abc, built 2026-11-09 16:05 UTC');
    expect(element.querySelector('time')?.getAttribute('datetime')).toBe('2026-11-09T16:05:12Z');
    expect(await axeViolations(element)).toEqual([]);
  });
});
