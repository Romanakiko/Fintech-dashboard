/**
 * Layout of one generated market update in Wasm linear memory: seven
 * consecutive u32 values (see `Update` in wasm/market-gen/src/model.rs).
 */
export const UPDATE_STRIDE = 7;

export const UpdateField = {
  instrument: 0,
  priceCents: 1,
  tradeQty: 2,
  bidCents: 3,
  askCents: 4,
  bidQty: 5,
  askQty: 6,
} as const;

/** Bumped together with ABI_VERSION in the Wasm crate. */
export const WASM_ABI_VERSION = 1;
