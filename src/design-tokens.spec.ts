// Checks the colour tokens in styles.scss against WCAG 2.2 AA, in both themes. axe-core
// cannot do this under jsdom, which does no layout or painting.
// @ts-expect-error TypeScript cannot type imports based on the `loader` attribute.
import styles from './styles.scss' with { loader: 'text' };

type Theme = Record<string, string>;

function tokensIn(block: string): Theme {
  return Object.fromEntries(
    [...block.matchAll(/--(color-[\w-]+):\s*(#[0-9a-f]{6})/gi)].map(([, name, hex]) => [name, hex]),
  );
}

/** The declarations between `start` and the next closing brace. */
function blockAfter(source: string, start: string): string {
  const from = source.indexOf(start);
  return source.slice(from, source.indexOf('}', from));
}

const light = tokensIn(blockAfter(styles as string, ':root {'));
const dark = {
  ...light,
  ...tokensIn(blockAfter(styles as string, '(prefers-color-scheme: dark)')),
};

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((index) => {
    const channel = parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
}

// Text needs 4.5:1; control borders and the focus ring need 3:1 (non-text contrast).
const PAIRS: readonly [foreground: string, background: string, minimum: number][] = [
  ['color-text', 'color-bg', 4.5],
  ['color-text', 'color-surface', 4.5],
  ['color-text', 'color-surface-alt', 4.5],
  ['color-text-muted', 'color-bg', 4.5],
  ['color-text-muted', 'color-surface', 4.5],
  ['color-text-muted', 'color-surface-alt', 4.5],
  ['color-accent', 'color-surface', 4.5],
  ['color-on-accent', 'color-accent', 4.5],
  ['color-on-accent', 'color-accent-strong', 4.5],
  ['color-danger', 'color-danger-surface', 4.5],
  ['color-danger', 'color-surface', 4.5],
  ['color-control-border', 'color-surface', 3],
  ['color-focus', 'color-bg', 3],
  ['color-focus', 'color-surface', 3],
];

describe('colour tokens', () => {
  it('defines every token in both themes', () => {
    const names = PAIRS.flatMap(([foreground, background]) => [foreground, background]);
    for (const name of names) {
      expect(light[name], `light ${name}`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(dark[name], `dark ${name}`).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(dark['color-bg']).not.toBe(light['color-bg']);
  });

  describe.each([
    ['light', light],
    ['dark', dark],
  ] as const)('%s theme', (_, theme) => {
    it.each(PAIRS)('%s on %s meets %d:1', (foreground, background, minimum) => {
      expect(contrast(theme[foreground], theme[background])).toBeGreaterThanOrEqual(minimum);
    });
  });
});
