import { UPDATE_STRIDE, UpdateField } from '../app/core/market-update';

export interface TestUpdate {
  instrument: number;
  priceCents: number;
  tradeQty: number;
  bidCents: number;
  askCents: number;
  bidQty: number;
  askQty: number;
}

/** Encodes updates in the same u32 layout the Wasm generator writes. */
export function encodeUpdates(updates: readonly TestUpdate[]): Uint32Array {
  const buffer = new Uint32Array(updates.length * UPDATE_STRIDE);
  updates.forEach((update, index) => {
    const offset = index * UPDATE_STRIDE;
    for (const [field, position] of Object.entries(UpdateField)) {
      buffer[offset + position] = update[field as keyof TestUpdate];
    }
  });
  return buffer;
}

/** The two trades of the task's worked example on one instrument. */
export function workedExampleUpdates(instrument = 0): TestUpdate[] {
  return [
    {
      instrument,
      priceCents: 10_000,
      tradeQty: 10,
      bidCents: 9_996,
      askCents: 10_000,
      bidQty: 500,
      askQty: 500,
    },
    {
      instrument,
      priceCents: 10_200,
      tradeQty: 30,
      bidCents: 10_196,
      askCents: 10_200,
      bidQty: 600,
      askQty: 400,
    },
  ];
}
