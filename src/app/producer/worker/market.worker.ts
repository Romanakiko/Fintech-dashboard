import { type ProducerEvent, isProducerCommand } from '../../core/protocol';
import { ProducerEngine } from './producer-engine';
import { TimerScheduler } from './scheduler';
import { loadWasmMarketGenerator } from './wasm-market-generator';

const emit = (event: ProducerEvent): void => postMessage(event);
const now = (): number => performance.now();

const engine = new ProducerEngine({
  loadGenerator: loadWasmMarketGenerator,
  scheduler: new TimerScheduler(now),
  emit,
  now,
});

addEventListener('message', ({ data }: MessageEvent<unknown>) => {
  if (!isProducerCommand(data)) {
    emit({
      type: 'error',
      runId: null,
      code: 'INVALID_COMMAND',
      message: 'Rejected a malformed command',
      fatal: false,
    });
    return;
  }
  // Anticipated failures are reported by the engine itself; anything else is a bug.
  engine
    .handle(data)
    .catch((error: unknown) =>
      emit({
        type: 'error',
        runId: null,
        code: 'WORKER_CRASHED',
        message: String(error),
        fatal: true,
      }),
    );
});
