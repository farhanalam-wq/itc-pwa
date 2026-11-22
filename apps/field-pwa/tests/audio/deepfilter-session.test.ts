import { describe, expect, test } from 'bun:test';
import type { DeepFilterNetAudioWorkletHandle, DeepFilterNetAudioWorkletOptions } from '@workadventure/noise-suppression/deepfilternet';
import {
  createDeepFilterSession,
  DEEPFILTER_MAX_LOAD,
  DEEPFILTER_QUALIFICATION_MS,
  DEEPFILTER_SAMPLE_RATE,
  DEEPFILTER_TARGET_P95_LOAD,
  type DeepFilterTelemetryEvent
} from '../../src/audio/deepfilter-session';

function makeTrack() {
  const track = { readyState: 'live' as MediaStreamTrackState, stopped: false, stop() { this.stopped = true; } };
  return track as unknown as MediaStreamTrack & { stopped: boolean };
}

function makeStream(track = makeTrack()) {
  return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
}

function makeContext(sampleRate = DEEPFILTER_SAMPLE_RATE) {
  const outputTrack = makeTrack();
  const source = {
    connect: () => undefined,
    disconnect: () => undefined
  } as unknown as MediaStreamAudioSourceNode;
  const node = {
    connect: () => undefined,
    disconnect: () => undefined,
    port: { addEventListener: () => undefined, removeEventListener: () => undefined, start: () => undefined }
  } as unknown as AudioWorkletNode;
  const destination = {
    stream: makeStream(outputTrack)
  } as unknown as MediaStreamAudioDestinationNode;
  let state: AudioContextState = 'running';
  const context = {
    sampleRate,
    get state() { return state; },
    resume: async () => { state = 'running'; },
    suspend: async () => { state = 'suspended'; },
    close: async () => { state = 'closed'; },
    createMediaStreamSource: () => source,
    createMediaStreamDestination: () => destination
  } as unknown as AudioContext;
  return { context, outputTrack, source, node, destination };
}

function readyHandle(node: AudioWorkletNode, dispose = () => undefined): DeepFilterNetAudioWorkletHandle {
  return { node, ready: Promise.resolve({ type: 'ready', frameSamples: 480 }), dispose } as DeepFilterNetAudioWorkletHandle;
}

function baseOptions(context = makeContext(), onTelemetry?: (event: DeepFilterTelemetryEvent) => void) {
  return {
    isSecureContext: () => true,
    supportsAudioWorklet: () => true,
    createContext: () => context.context,
    createWorklet: async (_context: AudioContext, _options: DeepFilterNetAudioWorkletOptions) => readyHandle(context.node),
    onTelemetry
  };
}

describe('DeepFilterSession', () => {
  test('fails closed when the browser is not a secure context', async () => {
    let contextCreated = false;
    const events: DeepFilterTelemetryEvent[] = [];
    const session = createDeepFilterSession({
      ...baseOptions(makeContext(), (event) => events.push(event)),
      isSecureContext: () => false,
      createContext: () => { contextCreated = true; return makeContext().context; }
    });

    const result = await session.ready;
    expect(result.state).toBe('failed');
    expect(result.reason).toBe('insecure_context');
    expect(contextCreated).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: 'capability_check', supported: false, reason: 'insecure_context' }));
  });

  test('fails closed when AudioWorklet is unsupported or a browser cannot provide 48 kHz', async () => {
    const unsupported = createDeepFilterSession({
      ...baseOptions(),
      supportsAudioWorklet: () => false
    });
    expect(await unsupported.ready).toMatchObject({ state: 'failed', reason: 'audio_worklet_unavailable' });

    const wrongRateContext = makeContext(44_100);
    const wrongRate = createDeepFilterSession(baseOptions(wrongRateContext));
    expect(await wrongRate.ready).toMatchObject({ state: 'failed', reason: 'context_sample_rate_unsupported' });
  });

  test('applies the configured model and qualification thresholds', async () => {
    const context = makeContext();
    const mic = makeStream();
    let receivedOptions: DeepFilterNetAudioWorkletOptions | undefined;
    const session = createDeepFilterSession({
      ...baseOptions(context),
      createWorklet: async (_audioContext, options) => {
        receivedOptions = options;
        return readyHandle(context.node);
      }
    });

    expect((await session.ready).state).toBe('ready');
    const attached = await session.attach(mic);
    expect(attached.attached).toBe(true);
    expect(receivedOptions).toMatchObject({
      speechAttenuationDb: 25,
      pauseAttenuationDb: 45,
      pauseGateLookaheadFrames: 1,
      postGain: true,
      maxLoad: DEEPFILTER_MAX_LOAD,
      loadReportAfterMs: DEEPFILTER_QUALIFICATION_MS,
      bypassUntilReady: false
    });
    expect(DEEPFILTER_TARGET_P95_LOAD).toBe(0.45);
    await session.dispose();
  });

  test('reports and cleans up after initialization failure without stopping the source track', async () => {
    const micTrack = makeTrack();
    const context = makeContext();
    const events: DeepFilterTelemetryEvent[] = [];
    const session = createDeepFilterSession({
      ...baseOptions(context, (event) => events.push(event)),
      createWorklet: async () => { throw new Error('model fetch failed'); }
    });

    const result = await session.ready;
    expect(result).toMatchObject({ state: 'failed', reason: 'initialization_failed' });
    expect(micTrack.stopped).toBe(false);
    expect(context.outputTrack.stopped).toBe(true);
    expect(context.context.state).toBe('closed');
    expect(events).toContainEqual(expect.objectContaining({ type: 'fallback', reason: 'initialization_failed' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'resource_cleanup', contextClosed: true }));
  });

  test('switches to overloaded state and stops only the owned processed track', async () => {
    const micTrack = makeTrack();
    const mic = makeStream(micTrack);
    const context = makeContext();
    let options: DeepFilterNetAudioWorkletOptions | undefined;
    const session = createDeepFilterSession({
      ...baseOptions(context),
      createWorklet: async (_audioContext, value) => { options = value; return readyHandle(context.node); }
    });

    expect((await session.ready).state).toBe('ready');
    expect((await session.attach(mic)).attached).toBe(true);
    options?.onOverload?.(0.61);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.state).toBe('overloaded');
    expect(micTrack.stopped).toBe(false);
    expect(context.outputTrack.stopped).toBe(true);
    expect(context.context.state).toBe('closed');
  });

  test('discards the session when the qualification p95 misses target', async () => {
    const context = makeContext();
    let options: DeepFilterNetAudioWorkletOptions | undefined;
    const events: DeepFilterTelemetryEvent[] = [];
    const session = createDeepFilterSession({
      ...baseOptions(context, (event) => events.push(event)),
      createWorklet: async (_audioContext, value) => { options = value; return readyHandle(context.node); }
    });
    expect((await session.ready).state).toBe('ready');
    options?.onLoadReport?.({ windows: 6, medianLoad: 0.4, p95Load: 0.5, maxLoad: 0.6, slowFrames: 0, frames: 4500 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.state).toBe('failed');
    expect(session.qualificationState).toBe('failed');
    expect(session.attachReady(makeStream()).attached).toBe(false);
    expect(context.outputTrack.stopped).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: 'fallback', reason: 'load_qualification_failed' }));
  });

  test('handles rapid attach, detach, and stop cycles without stopping the original stream', async () => {
    const micTrack = makeTrack();
    const mic = makeStream(micTrack);
    const context = makeContext();
    const session = createDeepFilterSession(baseOptions(context));
    expect((await session.ready).state).toBe('ready');

    for (let index = 0; index < 4; index += 1) {
      expect(session.attachReady(mic).attached).toBe(true);
      await session.detach();
      expect(await session.activate()).toBe(true);
    }
    await session.dispose();

    expect(session.state).toBe('disposed');
    expect(micTrack.stopped).toBe(false);
    expect(context.outputTrack.stopped).toBe(true);
  });

  test('disposes safely when stop happens while worklet initialization is pending', async () => {
    const context = makeContext();
    let resolveWorklet!: (handle: DeepFilterNetAudioWorkletHandle) => void;
    let handleDisposed = false;
    const session = createDeepFilterSession({
      ...baseOptions(context),
      createWorklet: () => new Promise((resolve) => { resolveWorklet = resolve; })
    });

    await Promise.resolve();
    const disposePromise = session.dispose();
    // Disposal must not wait on a model/WASM fetch; the package timeout does
    // not cover that download and it may never settle while the page is closing.
    await disposePromise;
    resolveWorklet(readyHandle(context.node, () => { handleDisposed = true; }));
    const result = await session.ready;

    expect(result.state).toBe('disposed');
    expect(handleDisposed).toBe(true);
    expect(context.outputTrack.stopped).toBe(true);
    expect(context.context.state).toBe('closed');
  });
});
