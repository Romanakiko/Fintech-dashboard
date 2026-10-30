// Contract test: executes the compiled market_gen.wasm through the raw exports the worker relies on.
// @ts-expect-error TypeScript cannot type imports based on the `loader` attribute.
import wasmBytes from '../../../../public/wasm/market_gen.wasm' with { loader: 'binary' };
import { UPDATE_STRIDE as STRIDE, WASM_ABI_VERSION } from '../../core/market-update';

interface MarketGenExports {
  memory: WebAssembly.Memory;
  abi_version(): number;
  update_stride(): number;
  init(seedLo: number, seedHi: number, instruments: number, maxBatch: number): number;
  generate(n: number): number;
  last_error(): number;
}

async function instantiate(): Promise<MarketGenExports> {
  const { instance } = await WebAssembly.instantiate(wasmBytes as Uint8Array<ArrayBuffer>);
  return instance.exports as unknown as MarketGenExports;
}

function generate(wasm: MarketGenExports, n: number): Uint32Array {
  const ptr = wasm.generate(n);
  expect(ptr, `generate(${n}) failed with ${wasm.last_error()}`).not.toBe(0);
  return new Uint32Array(wasm.memory.buffer, ptr >>> 0, n * STRIDE).slice();
}

function invariantViolations(batch: Uint32Array, instruments: number): string[] {
  const violations: string[] = [];
  for (let offset = 0; offset < batch.length; offset += STRIDE) {
    const [instrument, price, qty, bid, ask, bidQty, askQty] = batch.subarray(
      offset,
      offset + STRIDE,
    );
    const at = `update ${offset / STRIDE}`;
    if (instrument >= instruments) violations.push(`${at}: instrument ${instrument}`);
    if (bid <= 0 || bid >= ask) violations.push(`${at}: bid ${bid} / ask ${ask}`);
    if (price !== bid && price !== ask) violations.push(`${at}: price ${price} not at bid/ask`);
    if (qty < 1 || qty > 1000) violations.push(`${at}: trade qty ${qty}`);
    if (bidQty > 10_000 || askQty > 10_000) violations.push(`${at}: book qty ${bidQty}/${askQty}`);
  }
  return violations;
}

describe('market_gen.wasm contract', () => {
  let wasm: MarketGenExports;

  beforeEach(async () => {
    wasm = await instantiate();
  });

  it('exposes the ABI version and update record layout the app expects', () => {
    expect(wasm.abi_version()).toBe(WASM_ABI_VERSION);
    expect(wasm.update_stride()).toBe(STRIDE);
    expect(wasm.memory).toBeInstanceOf(WebAssembly.Memory);
  });

  it('returns exactly the requested number of valid updates', () => {
    expect(wasm.init(42, 0, 50, 1000)).toBe(0);
    for (const n of [1, 7, 1000]) {
      const batch = generate(wasm, n);
      expect(batch.length).toBe(n * STRIDE);
      expect(invariantViolations(batch, 50)).toEqual([]);
    }
  });

  it('reproduces the same stream for the same seed and differs for another', () => {
    wasm.init(7, 1, 5, 500);
    const first = generate(wasm, 500);
    wasm.init(7, 1, 5, 500);
    const replay = generate(wasm, 500);
    wasm.init(8, 1, 5, 500);
    const other = generate(wasm, 500);

    expect(replay).toEqual(first);
    expect(other).not.toEqual(first);
  });

  it('reports invalid calls through error codes', () => {
    expect(wasm.generate(10)).toBe(0);
    expect(wasm.last_error()).toBe(-4); // not initialised

    expect(wasm.init(1, 0, 0, 10)).toBe(-1); // instrument count out of range
    expect(wasm.init(1, 0, 51, 10)).toBe(-1);
    expect(wasm.init(1, 0, 5, 1001)).toBe(-2); // batch capacity out of range

    expect(wasm.init(1, 0, 5, 10)).toBe(0);
    expect(wasm.generate(11)).toBe(0);
    expect(wasm.last_error()).toBe(-3); // batch larger than capacity
  });
});
