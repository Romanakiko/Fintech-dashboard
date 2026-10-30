// Copies the release Wasm build into public/ (served at /wasm/market_gen.wasm)
// and enforces the binary size budget.
import { copyFileSync, mkdirSync, statSync } from 'node:fs';

const MAX_BYTES = 50 * 1024;
const source = new URL(
  '../wasm/market-gen/target/wasm32-unknown-unknown/release/market_gen.wasm',
  import.meta.url,
);
const targetDir = new URL('../public/wasm/', import.meta.url);

const { size } = statSync(source);
if (size > MAX_BYTES) {
  console.error(`market_gen.wasm is ${size} bytes, over the ${MAX_BYTES}-byte budget`);
  process.exit(1);
}

mkdirSync(targetDir, { recursive: true });
copyFileSync(source, new URL('market_gen.wasm', targetDir));
console.log(`market_gen.wasm: ${(size / 1024).toFixed(1)} kB -> public/wasm/`);
