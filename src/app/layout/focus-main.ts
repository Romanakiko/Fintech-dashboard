/**
 * Moves focus to the page's main heading, or to `<main>` itself if there is none.
 *
 * Used after a client-side navigation and when the focused control is about to disappear
 * (Retry), so keyboard and screen reader users keep their place instead of landing on
 * `<body>`.
 */
export function focusMainHeading(document: Document): void {
  const main = document.getElementById('main');
  (main?.querySelector<HTMLElement>('h1') ?? main)?.focus();
}
