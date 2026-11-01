// @ts-expect-error TypeScript cannot type imports based on the `loader` attribute.
import wasmBytes from '../../../../public/wasm/market_gen.wasm' with { loader: 'binary' };
import { UPDATE_STRIDE } from '../../core/market-update';
import { ProducerError } from './producer-engine';
import { loadWasmMarketGenerator } from './wasm-market-generator';

const WASM_URL = 'wasm/market_gen.wasm';
/** The smallest valid module: magic number and version, no exports. */
const EMPTY_MODULE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

const serve = (body: BodyInit, init?: ResponseInit) => () =>
  Promise.resolve(new Response(body, init));
const serveWasm = (contentType = 'application/wasm') =>
  serve(wasmBytes as Uint8Array<ArrayBuffer>, { headers: { 'Content-Type': contentType } });

function thrownBy(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the action to throw');
}

describe('loadWasmMarketGenerator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('compiles a module served as application/wasm by streaming', async () => {
    const streaming = vi.spyOn(WebAssembly, 'instantiateStreaming');
    const generator = await loadWasmMarketGenerator(WASM_URL, serveWasm());

    expect(streaming).toHaveBeenCalledOnce();
    generator.init([42, 0], 3, 10);
    const batch = generator.generate(10);
    expect(batch).toHaveLength(10 * UPDATE_STRIDE);
    for (let offset = 0; offset < batch.length; offset += UPDATE_STRIDE) {
      expect(batch[offset]).toBeLessThan(3);
    }
  });

  it('falls back to buffered compilation for any other MIME type', async () => {
    const streaming = vi.spyOn(WebAssembly, 'instantiateStreaming');
    const generator = await loadWasmMarketGenerator(
      WASM_URL,
      serveWasm('application/octet-stream'),
    );

    expect(streaming).not.toHaveBeenCalled();
    generator.init([42, 0], 3, 10);
    expect(generator.generate(5)).toHaveLength(5 * UPDATE_STRIDE);
  });

  it('returns views into Wasm memory instead of copies', async () => {
    const generator = await loadWasmMarketGenerator(WASM_URL, serveWasm());
    generator.init([1, 0], 5, 100);
    const first = generator.generate(100);
    const second = generator.generate(100);

    expect(second.buffer).toBe(first.buffer);
    expect(second.byteOffset).toBe(first.byteOffset);
  });

  describe('load failures', () => {
    it('maps a network error to WASM_FETCH_FAILED', async () => {
      const offline = () => Promise.reject(new TypeError('Failed to fetch'));

      await expect(loadWasmMarketGenerator(WASM_URL, offline)).rejects.toMatchObject({
        code: 'WASM_FETCH_FAILED',
        message: `Could not fetch ${WASM_URL}: Failed to fetch`,
      });
    });

    it('maps an HTTP error status to WASM_FETCH_FAILED', async () => {
      await expect(
        loadWasmMarketGenerator(WASM_URL, serve('Not found', { status: 404 })),
      ).rejects.toMatchObject({
        code: 'WASM_FETCH_FAILED',
        message: expect.stringContaining('HTTP 404'),
      });
    });

    it('maps bytes that are not Wasm to WASM_COMPILE_FAILED', async () => {
      const html = serve('<!doctype html>', { headers: { 'Content-Type': 'text/html' } });

      await expect(loadWasmMarketGenerator(WASM_URL, html)).rejects.toMatchObject({
        code: 'WASM_COMPILE_FAILED',
      });
    });

    it('maps a module without the expected exports to ABI_MISMATCH', async () => {
      const empty = serve(EMPTY_MODULE, { headers: { 'Content-Type': 'application/wasm' } });

      await expect(loadWasmMarketGenerator(WASM_URL, empty)).rejects.toMatchObject({
        code: 'ABI_MISMATCH',
        message: expect.stringContaining('abi_version'),
      });
    });
  });

  describe('call failures', () => {
    it('maps a rejected init to INIT_REJECTED', async () => {
      const generator = await loadWasmMarketGenerator(WASM_URL, serveWasm());
      const error = thrownBy(() => generator.init([1, 0], 51, 10));

      expect(error).toBeInstanceOf(ProducerError);
      expect(error).toMatchObject({
        code: 'INIT_REJECTED',
        message: expect.stringContaining('-1'),
      });
    });

    it('maps a failed generate call to GENERATION_FAILED', async () => {
      const generator = await loadWasmMarketGenerator(WASM_URL, serveWasm());
      generator.init([1, 0], 5, 10);
      const error = thrownBy(() => generator.generate(11));

      expect(error).toBeInstanceOf(ProducerError);
      expect(error).toMatchObject({
        code: 'GENERATION_FAILED',
        message: expect.stringContaining('-3'),
      });
    });
  });
});
