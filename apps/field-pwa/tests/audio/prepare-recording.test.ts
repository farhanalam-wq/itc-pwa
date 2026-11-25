import { expect, test } from 'bun:test';
import { prepareDenoiserForRecording } from '../../src/audio/prepare-recording';
import type { DeepFilterSession, DeepFilterInitializationResult } from '../../src/audio/deepfilter-session';

test('Record during cold model loading waits for readiness and resumes before capture', async () => {
  let resolve!: (value: DeepFilterInitializationResult) => void;
  let state: DeepFilterSession['state'] = 'initializing';
  let resumes = 0;
  let captureStarted = false;
  const session = {
    get state() { return state; },
    ready: new Promise<DeepFilterInitializationResult>((done) => { resolve = done; }),
    async activate() { resumes++; return true; }
  };
  const start = prepareDenoiserForRecording(session).then(() => { captureStarted = true; });
  expect(resumes).toBe(1);
  await Promise.resolve();
  expect(captureStarted).toBe(false);
  state = 'ready';
  resolve({ state: 'ready' });
  await start;
  expect(resumes).toBe(2);
  expect(captureStarted).toBe(true);
  // A subsequent short recording can use the same prepared session.
  await prepareDenoiserForRecording(session);
  expect(resumes).toBe(4);
});

test('initialization and resume failures prevent capture and expose the reason', async () => {
  let captureStarted = false;
  const session = {
    state: 'failed' as const,
    reason: 'initialization_failed' as const,
    ready: Promise.resolve({ state: 'failed' as const, reason: 'initialization_failed' as const }),
    async activate() { return true; }
  };
  await expect(prepareDenoiserForRecording(session).then(() => { captureStarted = true; })).rejects.toThrow('initialization_failed');
  expect(captureStarted).toBe(false);
  await expect(prepareDenoiserForRecording({ ...session, async activate() { return false; } })).rejects.toThrow('context_resume_failed');
});

test('hung model loading times out rather than starting an original-only recording', async () => {
  const session = {
    state: 'initializing' as const,
    ready: new Promise<DeepFilterInitializationResult>(() => undefined),
    async activate() { return true; }
  };
  await expect(prepareDenoiserForRecording(session, 5)).rejects.toThrow('denoiser_prepare_timeout');
});
