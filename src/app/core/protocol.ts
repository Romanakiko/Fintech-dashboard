import type { InstrumentTotals } from './aggregator';
import { type ProducerSettings, isValidSettings } from './settings';

/** 64-bit generator seed split into two u32 halves for the Wasm ABI. */
export type Seed = readonly [lo: number, hi: number];

/** Main thread -> worker. Every run-scoped command carries the run it targets. */
export type ProducerCommand =
  | { readonly type: 'load'; readonly wasmUrl: string }
  | {
      readonly type: 'start';
      readonly runId: number;
      readonly settings: ProducerSettings;
      readonly seed: Seed;
    }
  | { readonly type: 'pause'; readonly runId: number }
  | { readonly type: 'resume'; readonly runId: number }
  | { readonly type: 'ack'; readonly runId: number; readonly seq: number };

export interface ProducerStats {
  readonly totalUpdates: number;
  readonly batches: number;
  /** Time spent generating and aggregating the latest batch. */
  readonly lastBatchMs: number;
  readonly updatesPerSecond: number;
  /** Ticks that fired more than one interval late and were re-anchored instead of bursting. */
  readonly lateTicks: number;
}

export type ProducerErrorCode =
  | 'WASM_FETCH_FAILED'
  | 'WASM_COMPILE_FAILED'
  | 'ABI_MISMATCH'
  | 'INIT_REJECTED'
  | 'GENERATION_FAILED'
  | 'INVALID_COMMAND'
  | 'WORKER_CRASHED';

/** Worker -> main thread. */
export type ProducerEvent =
  | { readonly type: 'ready' }
  | { readonly type: 'status'; readonly runId: number; readonly state: 'running' | 'paused' }
  | {
      readonly type: 'snapshot';
      readonly runId: number;
      readonly seq: number;
      readonly stats: ProducerStats;
      readonly instruments: readonly InstrumentTotals[];
    }
  | {
      readonly type: 'error';
      readonly runId: number | null;
      readonly code: ProducerErrorCode;
      readonly message: string;
      /** A fatal error stops the producer until it is reloaded. */
      readonly fatal: boolean;
    };

const isRunId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const isUint32 = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;

/** Validates untrusted input at the worker boundary. */
export function isProducerCommand(value: unknown): value is ProducerCommand {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const command = value as Record<string, unknown>;
  switch (command['type']) {
    case 'load':
      return typeof command['wasmUrl'] === 'string' && command['wasmUrl'] !== '';
    case 'start': {
      const seed = command['seed'];
      return (
        isRunId(command['runId']) &&
        isValidSettings(command['settings']) &&
        Array.isArray(seed) &&
        seed.length === 2 &&
        seed.every(isUint32)
      );
    }
    case 'pause':
    case 'resume':
      return isRunId(command['runId']);
    case 'ack':
      return isRunId(command['runId']) && isUint32(command['seq']);
    default:
      return false;
  }
}
