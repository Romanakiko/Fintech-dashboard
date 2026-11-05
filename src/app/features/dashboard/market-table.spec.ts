import { TestBed } from '@angular/core/testing';
import type { MarketRow } from '../../state/market.store';
import { axeViolations } from '../../../testing/axe';
import { MarketTable } from './market-table';

const WORKED_EXAMPLE: MarketRow = {
  symbol: 'ALFA',
  lastPriceCents: 10_200,
  spreadCents: 4,
  volume: 40,
  vwapCents: '10150',
  imbalance: 0.2,
};
const NO_DATA: MarketRow = {
  symbol: 'BETA',
  lastPriceCents: null,
  spreadCents: null,
  volume: 0,
  vwapCents: null,
  imbalance: null,
};

describe('MarketTable', () => {
  let element: HTMLElement;

  async function render(rows: readonly MarketRow[]): Promise<void> {
    const fixture = TestBed.createComponent(MarketTable);
    fixture.componentRef.setInput('rows', rows);
    await fixture.whenStable();
    element = fixture.nativeElement as HTMLElement;
  }

  const cellsOf = (symbol: string) =>
    [...element.querySelectorAll('tbody tr')]
      .find((row) => row.querySelector('th')?.textContent?.trim() === symbol)
      ?.querySelectorAll('td');
  /** What a screen reader announces: the text without aria-hidden parts. */
  function textOf(cell: Element): string | undefined {
    const spoken = cell.cloneNode(true) as Element;
    spoken.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => hidden.remove());
    return spoken.textContent?.replace(/\s+/g, ' ').trim();
  }

  it('shows the worked example formatted as currency and signed imbalance', async () => {
    await render([WORKED_EXAMPLE]);

    expect([...(cellsOf('ALFA') ?? [])].map(textOf)).toEqual([
      '$102.00',
      '$0.04',
      '40',
      '$101.50',
      '+0.20',
    ]);
  });

  it('shows unavailable values as a dash, announced as "not available", and zero volume', async () => {
    await render([NO_DATA]);
    const cells = [...(cellsOf('BETA') ?? [])];

    expect(cells.map(textOf)).toEqual([
      'not available',
      'not available',
      '0',
      'not available',
      'not available',
    ]);
    expect(cells[0].querySelector('[aria-hidden="true"]')?.textContent).toBe('—');
  });

  it('keeps each instrument in its own row', async () => {
    await render([WORKED_EXAMPLE, NO_DATA]);

    expect(textOf(cellsOf('ALFA')?.[2] as Element)).toBe('40');
    expect(textOf(cellsOf('BETA')?.[2] as Element)).toBe('0');
  });

  it('uses table semantics: caption, column headers and row headers', async () => {
    await render([WORKED_EXAMPLE]);

    expect(element.querySelector('caption')?.textContent?.trim()).toBe(
      'Instruments in the current run',
    );
    expect(element.querySelectorAll('thead th[scope="col"]')).toHaveLength(6);
    expect(element.querySelector('tbody th[scope="row"]')?.textContent?.trim()).toBe('ALFA');
  });

  it('has no accessibility violations', async () => {
    await render([WORKED_EXAMPLE, NO_DATA]);

    expect(await axeViolations(element)).toEqual([]);
  });
});
