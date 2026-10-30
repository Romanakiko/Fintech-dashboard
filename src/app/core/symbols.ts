import { SETTINGS_LIMITS } from './settings';

/** Fictional instrument symbols; the Wasm generator identifies instruments by index. */
// prettier-ignore
export const SYMBOLS: readonly string[] = [
  'ALFA', 'BETA', 'GAMA', 'DLTA', 'EPSI', 'ZETA', 'ETAH', 'THTA', 'IOTA', 'KAPA',
  'LMBD', 'MUON', 'NUON', 'XICO', 'OMCR', 'PICO', 'RHOX', 'SGMA', 'TAUX', 'UPSN',
  'PHIX', 'CHIX', 'PSIX', 'OMGA', 'ACME', 'BOLT', 'CRUX', 'DUNE', 'EMBR', 'FLUX',
  'GLOW', 'HELM', 'IRIS', 'JADE', 'KNOT', 'LUME', 'MOSS', 'NOVA', 'ONYX', 'PIKE',
  'QUIL', 'RUNE', 'SAGE', 'TIDE', 'UMBR', 'VALE', 'WISP', 'XENO', 'YARN', 'ZINC',
];

if (SYMBOLS.length < SETTINGS_LIMITS.instrumentCount.max) {
  throw new Error('Not enough instrument symbols for the maximum instrument count');
}

export function symbolOf(index: number): string {
  const symbol = SYMBOLS[index];
  if (symbol === undefined) {
    throw new RangeError(`No symbol for instrument ${index}`);
  }
  return symbol;
}
