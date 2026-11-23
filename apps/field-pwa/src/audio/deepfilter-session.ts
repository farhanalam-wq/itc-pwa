import type {
  DeepFilterNetAudioWorkletHandle,
  DeepFilterNetAudioWorkletOptions,
  LoadReport
} from '@workadventure/noise-suppression/deepfilternet';
import { persistQualificationResult, readQualificationResult } from './qualification-cache';

export const DEEPFILTER_SAMPLE_RATE = 48_000;
export const DEEPFILTER_MAX_LOAD = 0.55;
export const DEEPFILTER_TARGET_P95_LOAD = 0.45;
export const DEEPFILTER_QUALIFICATION_MS = 12_000;

export type DeepFilterFailureReason =
  | 'insecure_context'
  | 'audio_context_unavailable'
  | 'audio_worklet_unavailable'
  | 'audio_track_unavailable'
  | 'context_sample_rate_unsupported'
  | 'context_resume_failed'
  | 'initialization_failed'
  | 'load_qualification_failed'
  | 'overload'
  | 'disposed_during_initialization';

export type DeepFilterSessionState = 'initializing' | 'ready' | 'failed' | 'overloaded' | 'disposed';
export type DeepFilterQualificationState = 'pending' | 'qualified' | 'failed';

export type DeepFilterTelemetryEvent =
  | { type: 'initialization_started'; at: number }
  | { type: 'capability_check'; at: number; supported: boolean; reason?: DeepFilterFailureReason }
  | { type: 'model_initialized'; at: number; latencyMs: number }
  | { type: 'qualification_cache'; at: number; cacheHit: boolean; p95Load?: number }
  | { type: 'load_report'; at: number; report: LoadReport; qualified: boolean }
  | { type: 'overload'; at: number; load: number }
  | { type: 'fallback'; at: number; reason: DeepFilterFailureReason; message?: string }
  | { type: 'resource_cleanup'; at: number; contextClosed: boolean; processedTracksStopped: number };

export interface DeepFilterSessionOptions {
  onTelemetry?: (event: DeepFilterTelemetryEvent) => void;
  createContext?: (sampleRate: number) => AudioContext;
  createWorklet?: (context: AudioContext, options: DeepFilterNetAudioWorkletOptions) => Promise<DeepFilterNetAudioWorkletHandle>;
  isSecureContext?: () => boolean;
  supportsAudioWorklet?: () => boolean;
  now?: () => number;
}

export interface DeepFilterInitializationResult {
  state: 'ready' | 'failed' | 'overloaded' | 'disposed';
  reason?: DeepFilterFailureReason;
}

export type DeepFilterAttachResult =
  | { attached: true; stream: MediaStream }
  | { attached: false; reason: DeepFilterFailureReason };

function makeAudioContext(sampleRate: number): AudioContext {
  return new AudioContext({ sampleRate });
}

async function makeWorklet(context: AudioContext, options: DeepFilterNetAudioWorkletOptions) {
  const { createDeepFilterNetAudioWorklet } = await import('@workadventure/noise-suppression/deepfilternet');
  return createDeepFilterNetAudioWorklet(context, options);
}

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

/**
 * Prepares DeepFilterNet while the capture screen is open. It owns its 48 kHz
 * Web Audio context and processed destination, but never owns microphone tracks.
 * Attach the single capture stream only after `ready` resolves successfully.
 */
export class DeepFilterSession {
  readonly ready: Promise<DeepFilterInitializationResult>;

  private currentState: DeepFilterSessionState = 'initializing';
  private failureReason: DeepFilterFailureReason | undefined;
  private qualification: DeepFilterQualificationState = 'pending';
  private context: AudioContext | undefined;
  private source: MediaStreamAudioSourceNode | undefined;
  private destination: MediaStreamAudioDestinationNode | undefined;
  private worklet: DeepFilterNetAudioWorkletHandle | undefined;
  private disposed = false;
  private cleanupPromise: Promise<void> | undefined;
  private readonly startedAt: number;
  private readonly emit: (event: DeepFilterTelemetryEvent) => void;
  private readonly now: () => number;

  constructor(private readonly options: DeepFilterSessionOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.startedAt = this.now();
    this.emit = options.onTelemetry ?? (() => undefined);
    this.emit({ type: 'initialization_started', at: this.now() });
    this.ready = this.initialize();
  }

  get state(): DeepFilterSessionState {
    return this.currentState;
  }

  get qualificationState(): DeepFilterQualificationState {
    return this.qualification;
  }

  get reason(): DeepFilterFailureReason | undefined {
    return this.failureReason;
  }

  /** Resume from a user gesture, including while a suspended prewarm is pending. */
  async activate(): Promise<boolean> {
    const context = this.context;
    if (!context || this.disposed || this.currentState === 'failed' || this.currentState === 'overloaded') return false;
    try {
      await context.resume();
      if (context.state === 'running') return true;
    } catch (error) {
      this.emitFallback('context_resume_failed', error);
      return false;
    }
    this.emitFallback('context_resume_failed');
    return false;
  }

  private async initialize(): Promise<DeepFilterInitializationResult> {
    const failure = this.capabilityFailure();
    if (failure) return this.fail(failure);
    this.emit({ type: 'capability_check', at: this.now(), supported: true });

    try {
      const context = (this.options.createContext ?? makeAudioContext)(DEEPFILTER_SAMPLE_RATE);
      this.context = context;
      if (context.sampleRate !== DEEPFILTER_SAMPLE_RATE) return this.fail('context_sample_rate_unsupported');

      // Start the context opportunistically while the capture screen is open,
      // but do not hold up model fetching if autoplay policy suspends it. The
      // Record gesture can activate a pending warmup through activate().
      void context.resume().catch(() => undefined);
      if (this.disposed) return this.fail('disposed_during_initialization');

      const destination = context.createMediaStreamDestination();
      this.destination = destination;
      let overloadLoad: number | undefined;
      const cachedQualification = readQualificationResult();
      if (cachedQualification) this.qualification = 'qualified';
      this.emit({
        type: 'qualification_cache',
        at: this.now(),
        cacheHit: Boolean(cachedQualification),
        p95Load: cachedQualification?.p95Load
      });
      const handle = await (this.options.createWorklet ?? makeWorklet)(context, {
        speechAttenuationDb: 25,
        pauseAttenuationDb: 45,
        pauseGateLookaheadFrames: 1,
        postGain: true,
        maxLoad: DEEPFILTER_MAX_LOAD,
        loadReportAfterMs: cachedQualification ? 0 : DEEPFILTER_QUALIFICATION_MS,
        readyTimeoutMs: 120_000,
        bypassUntilReady: false,
        onLoadReport: (report) => {
          const qualified = report.p95Load < DEEPFILTER_TARGET_P95_LOAD;
          this.emit({
            type: 'load_report',
            at: this.now(),
            report,
            qualified
          });
          if (qualified) persistQualificationResult(report);
          this.qualification = qualified ? 'qualified' : 'failed';
          if (!qualified && !this.disposed) {
            this.currentState = 'failed';
            this.failureReason = 'load_qualification_failed';
            this.emitFallback('load_qualification_failed');
            void this.releaseResources();
          }
        },
        onOverload: (load) => {
          overloadLoad = load;
          if (this.disposed || this.currentState === 'failed' || this.currentState === 'disposed') return;
          this.currentState = 'overloaded';
          this.emit({ type: 'overload', at: this.now(), load });
          this.emitFallback('overload');
          void this.releaseResources();
        }
      });
      this.worklet = handle;

      if (this.disposed) {
        handle.dispose();
        return this.fail('disposed_during_initialization');
      }

      // There is no live source during prewarm. This keeps the graph/model
      // ready without opening another microphone or creating microphone audio.
      handle.node.connect(destination);
      await handle.ready;

      if (this.disposed) return this.fail('disposed_during_initialization');
      if (overloadLoad !== undefined || this.currentState === 'overloaded') {
        return { state: 'overloaded', reason: 'overload' };
      }
      if (this.qualification === 'failed') return this.fail('load_qualification_failed');

      this.currentState = 'ready';
      this.emit({ type: 'model_initialized', at: this.now(), latencyMs: Math.max(0, this.now() - this.startedAt) });
      return { state: 'ready' };
    } catch (error) {
      if (this.disposed) return this.fail('disposed_during_initialization');
      return this.fail('initialization_failed', error);
    }
  }

  /** Attach the already captured microphone stream without taking ownership of its tracks. */
  async attach(microphoneStream: MediaStream): Promise<DeepFilterAttachResult> {
    const readiness = await this.ready;
    if (readiness.state !== 'ready' || this.currentState !== 'ready' || this.disposed) {
      return { attached: false, reason: readiness.reason ?? this.stateFailureReason() };
    }
    const context = this.context;
    if (!context || context.state !== 'running') {
      const activated = await this.activate();
      if (!activated) return this.failAttach('context_resume_failed');
    }
    return this.attachReady(microphoneStream);
  }

  /** Synchronous attach for the Record handler after a ready-at-tap snapshot. */
  attachReady(microphoneStream: MediaStream): DeepFilterAttachResult {
    if (this.currentState !== 'ready' || this.disposed) {
      return { attached: false, reason: this.stateFailureReason() };
    }
    if (this.qualification === 'failed') return this.failAttach('load_qualification_failed');
    if (this.source) return { attached: false, reason: 'initialization_failed' };
    if (!microphoneStream.getAudioTracks().some((track) => track.readyState === 'live')) {
      return this.failAttach('audio_track_unavailable');
    }

    try {
      const context = this.context;
      const destination = this.destination;
      const worklet = this.worklet;
      if (!context || !destination || !worklet) return { attached: false, reason: 'initialization_failed' };
      if (context.state !== 'running') return this.failAttach('context_resume_failed');
      if (this.disposed || this.currentState !== 'ready') return { attached: false, reason: this.stateFailureReason() };
      const source = context.createMediaStreamSource(microphoneStream);
      source.connect(worklet.node);
      this.source = source;
      return { attached: true, stream: destination.stream };
    } catch {
      return this.failAttach('initialization_failed');
    }
  }

  /** Disconnect a finished recording but retain the prewarmed model for the next capture. */
  async detach(): Promise<void> {
    this.source?.disconnect();
    this.source = undefined;
    const context = this.context;
    if (context && context.state === 'running') await context.suspend().catch(() => undefined);
  }

  private capabilityFailure(): DeepFilterFailureReason | undefined {
    const secureContext = this.options.isSecureContext?.() ?? globalThis.isSecureContext;
    if (!secureContext) return this.reportCapabilityFailure('insecure_context');
    const hasContext = Boolean(this.options.createContext) || typeof AudioContext !== 'undefined';
    if (!hasContext) return this.reportCapabilityFailure('audio_context_unavailable');
    const supportsWorklet = this.options.supportsAudioWorklet
      ? this.options.supportsAudioWorklet()
      : typeof AudioWorkletNode !== 'undefined' && 'audioWorklet' in AudioContext.prototype;
    if (!supportsWorklet) return this.reportCapabilityFailure('audio_worklet_unavailable');
    return undefined;
  }

  private reportCapabilityFailure(reason: DeepFilterFailureReason): DeepFilterFailureReason {
    this.emit({ type: 'capability_check', at: this.now(), supported: false, reason });
    return reason;
  }

  private stateFailureReason(): DeepFilterFailureReason {
    if (this.failureReason) return this.failureReason;
    if (this.currentState === 'overloaded') return 'overload';
    if (this.disposed || this.currentState === 'disposed') return 'disposed_during_initialization';
    if (this.currentState === 'failed') return 'initialization_failed';
    return 'initialization_failed';
  }

  private emitFallback(reason: DeepFilterFailureReason, error?: unknown): void {
    this.emit({ type: 'fallback', at: this.now(), reason, message: errorMessage(error) });
  }

  private async fail(reason: DeepFilterFailureReason, error?: unknown): Promise<DeepFilterInitializationResult> {
    if (this.currentState !== 'overloaded' && !this.disposed) this.currentState = 'failed';
    this.failureReason = reason;
    if (reason !== 'disposed_during_initialization' && reason !== 'overload') {
      this.emitFallback(reason, error);
      if (reason === 'context_sample_rate_unsupported' || reason === 'context_resume_failed') {
        this.emit({ type: 'capability_check', at: this.now(), supported: false, reason });
      }
    }
    await this.releaseResources();
    return {
      state: this.currentState === 'overloaded' ? 'overloaded' : this.disposed ? 'disposed' : 'failed',
      reason
    };
  }

  private failAttach(reason: DeepFilterFailureReason): { attached: false; reason: DeepFilterFailureReason } {
    this.currentState = 'failed';
    this.failureReason = reason;
    this.emitFallback(reason);
    void this.releaseResources();
    return { attached: false, reason };
  }

  private releaseResources(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = (async () => {
      this.source?.disconnect();
      this.source = undefined;
      this.worklet?.dispose();
      this.worklet = undefined;
      let stopped = 0;
      for (const track of this.destination?.stream.getTracks() ?? []) {
        track.stop();
        stopped += 1;
      }
      this.destination = undefined;
      const context = this.context;
      this.context = undefined;
      if (context && context.state !== 'closed') await context.close().catch(() => undefined);
      this.emit({
        type: 'resource_cleanup',
        at: this.now(),
        contextClosed: !context || context.state === 'closed',
        processedTracksStopped: stopped
      });
    })();
    return this.cleanupPromise;
  }

  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.currentState = 'disposed';
    }
    await this.releaseResources();
  }
}

export function createDeepFilterSession(options?: DeepFilterSessionOptions): DeepFilterSession {
  return new DeepFilterSession(options);
}
