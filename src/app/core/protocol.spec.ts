import { isProducerCommand } from './protocol';
import { DEFAULT_SETTINGS } from './settings';

const start = { type: 'start', runId: 1, settings: DEFAULT_SETTINGS, seed: [1, 2] };

describe('isProducerCommand', () => {
  it.each([
    { type: 'load', wasmUrl: '/wasm/market_gen.wasm' },
    start,
    { ...start, seed: [0, 0xffff_ffff] },
    { type: 'pause', runId: 3 },
    { type: 'resume', runId: 3 },
    { type: 'ack', runId: 3, seq: 0 },
  ])('accepts %j', (command) => {
    expect(isProducerCommand(command)).toBe(true);
  });

  it.each([
    null,
    'start',
    {},
    { type: 'stop', runId: 1 },
    { type: 'load', wasmUrl: '' },
    { ...start, runId: 0 },
    { ...start, runId: 1.5 },
    { ...start, settings: { ...DEFAULT_SETTINGS, instrumentCount: 51 } },
    { ...start, seed: [1] },
    { ...start, seed: [-1, 0] },
    { ...start, seed: [0, 2 ** 32] },
    { type: 'pause' },
    { type: 'ack', runId: 1, seq: -1 },
  ])('rejects %j', (command) => {
    expect(isProducerCommand(command)).toBe(false);
  });
});
