import axe from 'axe-core';

/**
 * Runs axe-core against a rendered element and lists the violations.
 *
 * Colour contrast is off because jsdom does no layout or painting; design-tokens.spec.ts
 * checks the colour tokens instead. `region` is off by default because a component tested on its own sits
 * outside the app's landmarks; tests of the whole shell turn it back on.
 */
export async function axeViolations(
  context: Element,
  rules: Record<string, { enabled: boolean }> = {},
): Promise<string[]> {
  const { violations } = await axe.run(context, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, ...rules },
  });
  return violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} (${violation.nodes.map((node) => node.target.join(' ')).join(', ')})`,
  );
}
