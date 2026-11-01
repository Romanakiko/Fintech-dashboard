import { UPDATE_STRIDE, WASM_ABI_VERSION } from '../../core/market-update';
import type { Seed } from '../../core/protocol';
import { type MarketGenerator, ProducerError } from './producer-engine';

/** Raw exports of market_gen.wasm (wasm/market-gen/src/lib.rs). */
export interface MarketGenExports {
  memory: WebAssembly.Memory;
  abi_version(): number;
  update_stride(): number;
  /** Returns 0, or a negative error code. */
  init(seedLo: number, seedHi: number, instruments: number, maxBatch: number): number;
  /** Returns a pointer to the batch in `memory`, or 0 on error (see `last_error`). */
  generate(n: number): number;
  last_error(): number;
}

const EXPORTED_FUNCTIONS = [
  'abi_version',
  'update_stride',
  'init',
  'generate',
  'last_error',
] as const;

/** Fetches, compiles and checks market_gen.wasm. Every failure is a ProducerError. */
export async function loadWasmMarketGenerator(
  url: string,
  fetchWasm: (url: string) => Promise<Response> = fetch,
): Promise<MarketGenerator> {
  let response: Response;
  try {
    response = await fetchWasm(url);
  } catch (error) {
    throw new ProducerError('WASM_FETCH_FAILED', `Could not fetch ${url}: ${messageOf(error)}`);
  }
  if (!response.ok) {
    throw new ProducerError('WASM_FETCH_FAILED', `Could not fetch ${url}: HTTP ${response.status}`);
  }
  let instance: WebAssembly.Instance;
  try {
    instance = await instantiate(response);
  } catch (error) {
    throw new ProducerError('WASM_COMPILE_FAILED', `Could not compile ${url}: ${messageOf(error)}`);
  }
  return new WasmMarketGenerator(checkAbi(instance.exports));
}

async function instantiate(response: Response): Promise<WebAssembly.Instance> {
  // Streaming compilation only accepts the application/wasm MIME type.
  if (response.headers.get('Content-Type')?.startsWith('application/wasm')) {
    return (await WebAssembly.instantiateStreaming(response)).instance;
  }
  return (await WebAssembly.instantiate(await response.arrayBuffer())).instance;
}

function checkAbi(exports: WebAssembly.Exports): MarketGenExports {
  const missing: string[] = EXPORTED_FUNCTIONS.filter(
    (name) => typeof exports[name] !== 'function',
  );
  if (!(exports['memory'] instanceof WebAssembly.Memory)) {
    missing.push('memory');
  }
  if (missing.length > 0) {
    throw new ProducerError('ABI_MISMATCH', `The module is missing exports: ${missing.join(', ')}`);
  }
  const wasm = exports as unknown as MarketGenExports;
  const version = wasm.abi_version();
  const stride = wasm.update_stride();
  if (version !== WASM_ABI_VERSION || stride !== UPDATE_STRIDE) {
    throw new ProducerError(
      'ABI_MISMATCH',
      `Expected ABI ${WASM_ABI_VERSION} with stride ${UPDATE_STRIDE}, got ${version} with stride ${stride}`,
    );
  }
  return wasm;
}

class WasmMarketGenerator implements MarketGenerator {
  constructor(private readonly wasm: MarketGenExports) {}

  init(seed: Seed, instrumentCount: number, maxBatch: number): void {
    const code = this.wasm.init(seed[0], seed[1], instrumentCount, maxBatch);
    if (code !== 0) {
      throw new ProducerError(
        'INIT_REJECTED',
        `init(${instrumentCount} instruments, batch ${maxBatch}) failed with code ${code}`,
      );
    }
  }

  generate(count: number): Uint32Array {
    const ptr = this.wasm.generate(count);
    if (ptr === 0) {
      throw new ProducerError(
        'GENERATION_FAILED',
        `generate(${count}) failed with code ${this.wasm.last_error()}`,
      );
    }
    // A view, not a copy. Taking `memory.buffer` per batch also keeps it valid if memory grew.
    return new Uint32Array(this.wasm.memory.buffer, ptr >>> 0, count * UPDATE_STRIDE);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
