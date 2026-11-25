import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MAX_TRANSCRIBABLE_RECORDING_SECONDS } from '@itc/domain';
import { createApiClient } from '@itc/api-client';
import '@fontsource-variable/hanken-grotesk';
import { registerFieldServiceWorker } from './pwa/register-service-worker';
import {
  getOpfsSupport,
  recordingStore,
  type LocalRecording,
  type DenoisedAudioWriter,
  type RecordingWriter,
  type RecoveryReport,
  type StorageSnapshot
} from './storage';
import {
  createDeepFilterSession,
  type DeepFilterFailureReason,
  type DeepFilterSession,
  type DeepFilterTelemetryEvent
} from './audio/deepfilter-session';
import { startMetadataRegistrationSync, type MetadataRegistrationSyncController } from './sync/metadata-registration';
import { uploadPendingAudio, type ChunkUploadProgress } from './sync/audio-upload';
import './styles.css';

type Screen = 'capture' | 'history';
type RecorderState = 'ready' | 'starting' | 'recording' | 'paused' | 'stopping';
type Notice = { kind: 'info' | 'success' | 'error'; text: string };
interface ActiveDenoisedCapture {
  recorder: MediaRecorder;
  intentionalStop: boolean;
  writer?: DenoisedAudioWriter;
  session: DeepFilterSession;
  done: Promise<void>;
  finish: () => void;
  pendingChunks: Blob[];
  pendingBytes: number;
  writerReady: Promise<void>;
  failure?: { reason: string; errorCode: string; state: 'failed' | 'incomplete' | 'unsupported' };
}

function denoiserFailureState(reason?: DeepFilterFailureReason): 'failed' | 'unsupported' {
  return reason === 'insecure_context'
    || reason === 'audio_context_unavailable'
    || reason === 'audio_worklet_unavailable'
    || reason === 'audio_track_unavailable'
    || reason === 'context_sample_rate_unsupported'
    ? 'unsupported'
    : 'failed';
}

function normalizeMimeType(value: string): string {
  return value.toLowerCase().replace(/\s/g, '');
}

function logDenoiserTelemetry(event: DeepFilterTelemetryEvent): void {
  const details = (() => {
    switch (event.type) {
      case 'model_initialized': return { latencyMs: Math.round(event.latencyMs) };
      case 'load_report': return {
        windows: event.report.windows,
        p95Load: event.report.p95Load,
        maxLoad: event.report.maxLoad,
        slowFrames: event.report.slowFrames,
        qualified: event.qualified
      };
      case 'overload': return { load: event.load };
      case 'fallback': return { reason: event.reason, message: event.message };
      case 'capability_check': return { supported: event.supported, reason: event.reason };
      case 'qualification_cache': return { cacheHit: event.cacheHit, p95Load: event.p95Load };
      case 'resource_cleanup': return { contextClosed: event.contextClosed, processedTracksStopped: event.processedTracksStopped };
      case 'initialization_started': return {};
    }
  })();
  if (event.type === 'fallback' || event.type === 'overload') console.warn('[field-audio] denoiser', event.type, details);
  else console.info('[field-audio] denoiser', event.type, details);
}

const apiClient = createApiClient({ baseUrl: import.meta.env.VITE_API_BASE_URL || '/api' });
const FIELD_CAPTURE_STOP_SECONDS = MAX_TRANSCRIBABLE_RECORDING_SECONDS - 10;
const FIELD_CAPTURE_WARNING_SECONDS = FIELD_CAPTURE_STOP_SECONDS - 20;
const initialMeter = Array.from({ length: 21 }, (_, index) => 0.18 + (index % 4) * 0.025);
const support = getOpfsSupport();

function formatElapsed(seconds: number): [string, string, string] {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((value) => String(value).padStart(2, '0')) as [string, string, string];
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
  }).format(new Date(value));
}

function formatBytes(value: number): string {
  if (value < 1_000_000) return `${Math.max(1, Math.round(value / 1000))} KB`;
  return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)} MB`;
}

function formatStorageBytes(value: number): string {
  if (value < 1000) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = value / 1000;
  let unitIndex = 0;
  while (amount >= 1000 && unitIndex < units.length - 1) {
    amount /= 1000;
    unitIndex += 1;
  }
  return `${amount.toFixed(amount >= 100 ? 0 : 1)} ${units[unitIndex]}`;
}

function getPreferredMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return undefined;
  return [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4'
  ].find((type) => MediaRecorder.isTypeSupported(type));
}

function Icon({ name }: { name: 'mic' | 'pause' | 'play' | 'stop' | 'shield' | 'history' | 'record' | 'save' | 'close' }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  if (name === 'mic') return <svg viewBox="0 0 24 24" aria-hidden="true" {...common}><rect x="8.5" y="3" width="7" height="12" rx="3.5"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3m-3 0h6"/></svg>;
  if (name === 'pause') return <svg viewBox="0 0 24 24" aria-hidden="true" {...common}><path d="M8 5v14M16 5v14"/></svg>;
  if (name === 'play') return <svg viewBox="0 0 24 24" aria-hidden="true" {...common}><path d="m8 5 11 7-11 7z"/></svg>;
  if (name === 'stop') return <svg viewBox="0 0 24 24" aria-hidden="true" {...common}><rect x="6.5" y="6.5" width="11" height="11" rx="1"/></svg>;
  if (name === 'shield') return <svg viewBox="0 0 24 24" aria-hidden="true" {...common}><path d="m12 3 8 3.5v5c0 4.4-2.7 7.8-8 9.5-5.3-1.7-8-5.1-8-9.5v-5L12 3Z"/><path d="m8.5 12 2.2 2.2 4.8-5"/></svg>;
  if (name === 'history') return <svg viewBox="0 0 24 24" aria-hidden="true" {...common}><path d="M4 8a8 8 0 1 1-.2 7M4 4v4h4m4-1v5l3 2"/></svg>;
  if (name === 'save') return <svg viewBox="0 0 24 24" aria-hidden="true" {...common}><path d="M5 4h12l3 3v13H4V4h1Z"/><path d="M8 4v6h8V4M8 20v-6h8v6"/></svg>;
  if (name === 'close') return <svg viewBox="0 0 24 24" aria-hidden="true" {...common}><path d="m6 6 12 12M18 6 6 18"/></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true" {...common}><circle cx="12" cy="12" r="8"/></svg>;
}

function MetadataState({ recording }: { recording: LocalRecording }) {
  if (recording.metadataRegistrationState === 'registered') {
    return <span className="metadata-state linked">Manager metadata linked</span>;
  }
  if (recording.metadataRegistrationState === 'error') {
    return <span className="metadata-state failed" title={recording.metadataRegistrationError}>
      {recording.metadataRegistrationRetryable === false ? 'Sync blocked' : 'Manager link needs retry'}
    </span>;
  }
  if (recording.metadataRegistrationState === 'registering') {
    return <span className="metadata-state">Registering recording</span>;
  }
  return <span className="metadata-state">Waiting to sync</span>;
}

function StorageBreakdown({ snapshot, onProtect }: { snapshot: StorageSnapshot | null; onProtect?: () => void }) {
  if (!snapshot || snapshot.quota === undefined || snapshot.usage === undefined) {
    return <section className="storage-breakdown" aria-labelledby="storage-title">
      <div className="storage-heading"><h2 id="storage-title">Device storage</h2><span>Browser estimate unavailable</span></div>
      <p className="storage-scope">This browser does not expose this origin’s storage quota. It also cannot report the device’s total disk space.</p>
    </section>;
  }
  const quota = snapshot.quota;
  const used = Math.min(snapshot.usage, quota);
  const recordingAudio = Math.min(snapshot.recordingAudioBytes, used);
  const otherAppData = Math.max(0, used - recordingAudio);
  const available = Math.max(0, quota - used);
  const percent = (value: number) => quota > 0 ? `${(value / quota) * 100}%` : '0%';
  return <section className="storage-breakdown" aria-labelledby="storage-title">
    <div className="storage-heading"><h2 id="storage-title">Device storage</h2><span>{snapshot.persistent ? 'Protected storage' : 'Browser-managed storage'}</span></div>
    <div className="storage-meter" role="meter" aria-label="This app’s browser storage used" aria-valuemin={0} aria-valuemax={quota} aria-valuenow={used}>
      <i className="storage-meter-audio" style={{ width: percent(recordingAudio) }}/>
      <i className="storage-meter-other" style={{ width: percent(otherAppData) }}/>
      <i className="storage-meter-free" style={{ width: percent(available) }}/>
    </div>
    <div className="storage-breakdown-legend">
      <div><i className="storage-swatch audio"/><span>Field recordings</span><strong>{formatStorageBytes(recordingAudio)}</strong></div>
      <div><i className="storage-swatch other"/><span>Other site data</span><strong>{formatStorageBytes(otherAppData)}</strong></div>
      <div><i className="storage-swatch free"/><span>Available origin quota</span><strong>{formatStorageBytes(available)}</strong></div>
    </div>
    {onProtect && !snapshot.persistent && <button type="button" className="storage-prompt" onClick={onProtect}>Protect local audio</button>}
    <p className="storage-scope">{formatStorageBytes(used)} occupied of {formatStorageBytes(quota)} estimated origin storage. This quota is per browser origin and may change; it is not the laptop, phone, or tablet’s total disk space.</p>
  </section>;
}

function RecordingRow({
  recording,
  playingId,
  audioUrl,
  onPlay,
  storageAvailable,
  storageDriver,
  onRetry,
  onDeleteIncomplete
}: {
  recording: LocalRecording;
  playingId: string | null;
  audioUrl: string | null;
  onPlay: (recording: LocalRecording) => void;
  storageAvailable: boolean;
  storageDriver?: 'local' | 's3';
  onRetry: (recording: LocalRecording) => void;
  onDeleteIncomplete: (recording: LocalRecording) => void;
}) {
  const label = recording.outletName || 'Field recording';
  const localOnly = recording.syncState !== 'uploaded';
  const destination = storageDriver === 's3' ? 'S3' : storageDriver === 'local' ? 'API server' : 'server';
  const uploadStatus = recording.localState === 'incomplete' ? 'Partial · local only'
    : recording.syncState === 'uploaded' ? `Stored on ${destination}`
    : recording.syncState === 'uploading' ? `Uploading to ${destination}`
      : recording.syncState === 'error' ? 'Upload needs retry'
        : storageAvailable ? `Queued for ${destination}` : 'Storage service unavailable';
  return <article className="recording-row">
    <div className="row-main">
      <div className="row-title"><strong>{label}</strong><span>{recording.localState === 'incomplete' ? 'Incomplete' : 'On this phone'}</span></div>
      <div className="row-meta"><time dateTime={recording.startedAt}>{formatDateTime(recording.startedAt)}</time><span>{formatElapsed(recording.durationSeconds).slice(1).join(':')}</span><span>{formatBytes(recording.byteLength)}</span></div>
      <div className="row-states"><span className={localOnly ? 'audio-state local' : 'audio-state uploaded'} title={recording.lastSyncError}>{uploadStatus}</span><MetadataState recording={recording}/></div>
      {recording.localState === 'incomplete' && recording.incompleteReason && <p className="row-warning">{recording.incompleteReason}</p>}
      {recording.metadataRegistrationState === 'error' && recording.metadataRegistrationRetryable === false && recording.metadataRegistrationError && <p className="row-warning">{recording.metadataRegistrationError}</p>}
      {recording.localState === 'incomplete' && <button className="delete-incomplete-button" type="button" onClick={() => onDeleteIncomplete(recording)}>Delete partial recording</button>}
      {recording.localState === 'ready' && recording.syncState === 'error' && storageAvailable && <button className="retry-upload" type="button" onClick={() => onRetry(recording)}>Retry upload</button>}
      {playingId === recording.id && audioUrl && <audio className="audio-player" controls autoPlay src={audioUrl} aria-label={`Audio for ${label}, ${formatDateTime(recording.startedAt)}`} onEnded={() => onPlay(recording)}/>}
    </div>
    {recording.byteLength > 0 && <button className="listen-button" type="button" onClick={() => onPlay(recording)} aria-label={`${playingId === recording.id ? 'Close' : 'Play'} ${label}, ${formatDateTime(recording.startedAt)}`}>
      <Icon name={playingId === recording.id ? 'close' : 'play'}/>{playingId === recording.id ? 'Close' : 'Listen'}
    </button>}
  </article>;
}

function FieldApp() {
  const [screen, setScreen] = useState<Screen>('capture');
  const [recorderState, setRecorderState] = useState<RecorderState>('ready');
  const [records, setRecords] = useState<LocalRecording[]>([]);
  const [storage, setStorage] = useState<StorageSnapshot | null>(null);
  const [recovery, setRecovery] = useState<RecoveryReport | null>(null);
  const [apiHealth, setApiHealth] = useState<Awaited<ReturnType<typeof apiClient.getHealth>> | null>(null);
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [microphoneId, setMicrophoneId] = useState('');
  const [checkingMicrophones, setCheckingMicrophones] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [meterLevels, setMeterLevels] = useState(initialMeter);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [isPersistent, setIsPersistent] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [chunkQueue, setChunkQueue] = useState<ChunkUploadProgress[]>([]);
  const writerRef = useRef<RecordingWriter | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const denoisedCaptureRef = useRef<ActiveDenoisedCapture | null>(null);
  const denoiserSessionRef = useRef<DeepFilterSession | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const startedAtRef = useRef(0);
  const pausedAtRef = useRef(0);
  const pausedDurationRef = useRef(0);
  const stopRequestedRef = useRef(false);
  const stopReasonRef = useRef<'user' | 'limit'>('user');
  const writeErrorRef = useRef<string | null>(null);
  const denoisedStateWriteRef = useRef<Promise<unknown> | null>(null);
  const syncRef = useRef<MetadataRegistrationSyncController | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const meterSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const meterAnalyserRef = useRef<AnalyserNode | null>(null);
  const meterFrameRef = useRef(0);
  const lastMeterUpdateRef = useRef(0);
  const audioUrlRef = useRef<string | null>(null);

  const canStart = support.supported
    && recorderState === 'ready' && !checkingMicrophones;
  const orderedRecords = useMemo(() => [...records].sort((a, b) => b.startedAt.localeCompare(a.startedAt)), [records]);
  const displayRecords = orderedRecords.filter((record) => record.localState !== 'recording');
  const [hours, minutes, seconds] = formatElapsed(elapsed);

  useEffect(() => {
    if (screen !== 'capture') {
      if (recorderState === 'ready') {
        const session = denoiserSessionRef.current;
        denoiserSessionRef.current = null;
        void session?.dispose();
      }
      return;
    }
    if (denoiserSessionRef.current) return;

    const session = createDeepFilterSession({
      onTelemetry: (event) => {
        logDenoiserTelemetry(event);
        const capture = denoisedCaptureRef.current;
        if (!capture) return;
        const failure = event.type === 'overload'
          ? { reason: 'DeepFilterNet exceeded its processing load limit.', errorCode: 'denoiser_overloaded' }
          : event.type === 'load_report' && !event.qualified
            ? { reason: 'This device did not meet the denoising performance target.', errorCode: 'denoiser_performance_unqualified' }
            : event.type === 'fallback' && event.reason === 'context_resume_failed'
              ? { reason: 'The audio processing context stopped during recording.', errorCode: 'denoiser_audio_context_interrupted' }
              : undefined;
        if (!failure) return;
        capture.failure = { ...failure, state: 'incomplete' };
        setNotice({
          kind: 'info',
          text: 'The original recording is safe, but its denoised analysis copy stopped early and will not be analyzed.'
        });
        if (capture.recorder.state !== 'inactive') capture.recorder.stop();
      }
    });
    denoiserSessionRef.current = session;
  }, [screen, recorderState]);

  useEffect(() => () => {
    const session = denoiserSessionRef.current;
    denoiserSessionRef.current = null;
    void session?.dispose();
  }, []);

  const refreshLocalState = useCallback(async () => {
    try {
      const [items, snapshot, persistent] = await Promise.all([
        recordingStore.list(),
        recordingStore.storageSnapshot(),
        navigator.storage?.persisted ? navigator.storage.persisted() : Promise.resolve(false)
      ]);
      setRecords(items);
      setStorage(snapshot);
      setIsPersistent(persistent);
      setStorageError(null);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Local recording storage could not be opened.');
    }
  }, []);

  const refreshApiHealth = useCallback(async () => {
    if (!navigator.onLine) return;
    try {
      setApiHealth(await apiClient.getHealth());
    } catch {
      setApiHealth(null);
    }
  }, []);

  const stopMeter = useCallback(() => {
    cancelAnimationFrame(meterFrameRef.current);
    meterSourceRef.current?.disconnect();
    meterSourceRef.current = null;
    meterAnalyserRef.current = null;
    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
    setMeterLevels(initialMeter);
  }, []);

  const startMeter = useCallback(async (stream: MediaStream) => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    try {
      const context = new AudioContext();
      await context.resume();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);
      audioContextRef.current = context;
      meterSourceRef.current = source;
      meterAnalyserRef.current = analyser;
      const values = new Uint8Array(analyser.frequencyBinCount);
      const update = (time: number) => {
        meterFrameRef.current = requestAnimationFrame(update);
        if (time - lastMeterUpdateRef.current < 120) return;
        lastMeterUpdateRef.current = time;
        analyser.getByteFrequencyData(values);
        const levels = Array.from({ length: 21 }, (_, index) => {
          const value = values[Math.min(values.length - 1, Math.floor(index / 21 * values.length))] ?? 0;
          return Math.max(0.12, Math.min(1, 0.12 + value / 255 * 0.88));
        });
        setMeterLevels(levels);
      };
      meterFrameRef.current = requestAnimationFrame(update);
    } catch {
      // The recording still works if the browser cannot expose a level meter.
    }
  }, []);

  useEffect(() => {
    void refreshLocalState();
    void refreshApiHealth();
    const report = recordingStore.recoverInterrupted();
    void report.then((result) => {
      setRecovery(result);
      if (result.items.length) void refreshLocalState();
    }).catch((error) => setStorageError(error instanceof Error ? error.message : 'Interrupted recordings could not be checked.'));

    const sync = startMetadataRegistrationSync(apiClient, async () => {
      await uploadPendingAudio(apiClient, (progress) => setChunkQueue((current) => [progress, ...current.filter((item) => item.recordingId !== progress.recordingId)].slice(0, 4)));
      await refreshLocalState();
    });
    syncRef.current = sync;
    const onOnline = () => {
      setOnline(true);
      void refreshApiHealth();
      void refreshLocalState();
    };
    const onOffline = () => {
      setOnline(false);
    };
    const retryTimer = window.setInterval(() => {
      void refreshLocalState();
      if (!navigator.onLine) return;
      void refreshApiHealth();
      void sync.process().then((result) => {
        if (result.registered) void refreshLocalState();
      }).catch(() => undefined);
    }, 20_000);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.clearInterval(retryTimer);
      sync.stop();
      stopMeter();
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, [refreshApiHealth, refreshLocalState, stopMeter]);

  useEffect(() => {
    if (recorderState !== 'recording') return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setElapsed(Math.max(0, Math.floor((now - startedAtRef.current - pausedDurationRef.current) / 1000)));
    }, 250);
    return () => window.clearInterval(timer);
  }, [recorderState]);

  useEffect(() => {
    if (recorderState !== 'recording' || elapsed < FIELD_CAPTURE_STOP_SECONDS) return;
    handleStop('limit');
  }, [elapsed, recorderState]);

  useEffect(() => {
    if (recorderState !== 'starting' && recorderState !== 'recording' && recorderState !== 'paused' && recorderState !== 'stopping') return;
    const warnBeforeLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeLeave);
    return () => window.removeEventListener('beforeunload', warnBeforeLeave);
  }, [recorderState]);

  useEffect(() => {
    return () => {
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, []);

  async function handleEnablePersistence() {
    try {
      const persistent = await recordingStore.requestDurability();
      setIsPersistent(persistent);
      setNotice({ kind: persistent ? 'success' : 'info', text: persistent
        ? 'This browser will protect local recordings from routine storage cleanup.'
        : 'This browser did not grant persistent storage. Keep the app installed and avoid clearing site data.' });
      await refreshLocalState();
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Storage protection could not be requested.' });
    }
  }

  const refreshMicrophones = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    setMicrophones(devices.filter((device) =>
      device.kind === 'audioinput' && device.label && device.deviceId
      && device.deviceId !== 'default' && device.deviceId !== 'communications'));
  }, []);

  useEffect(() => {
    const onDeviceChange = () => { void refreshMicrophones().catch(() => undefined); };
    onDeviceChange();
    navigator.mediaDevices?.addEventListener('devicechange', onDeviceChange);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', onDeviceChange);
  }, [refreshMicrophones]);

  async function handleCheckMicrophones() {
    if (!navigator.mediaDevices?.getUserMedia) return;
    setCheckingMicrophones(true);
    setNotice(null);
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      await refreshMicrophones();
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof DOMException && error.name === 'NotAllowedError'
        ? 'Allow microphone access in your browser to see available inputs.'
        : 'Could not find a microphone. Check your device’s sound input settings.' });
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      setCheckingMicrophones(false);
    }
  }

  function startDenoisedCapture(
    recordingId: string,
    stream: MediaStream,
    mimeType: string,
    session: DeepFilterSession | null
  ): void {
    const markUnavailable = (reason: string, errorCode: string, state: 'failed' | 'unsupported' | 'incomplete' = 'failed') => {
      denoisedStateWriteRef.current = recordingStore.markDenoisedAudioUnavailable(recordingId, reason, state, errorCode).catch(() => undefined);
      setNotice({
        kind: 'info',
        text: 'The original recording is safe, but a complete denoised analysis copy is unavailable. Pyannote will not receive the original audio for this recording.'
      });
    };

    if (!session || session.state !== 'ready') {
      const reason = session?.reason ?? (session?.state === 'initializing' ? 'model_not_ready_at_record_tap' : 'denoiser_not_available');
      const state = denoiserFailureState(session?.reason);
      markUnavailable(reason, session?.reason ?? 'denoiser_not_ready', session?.reason ? state : 'failed');
      return;
    }

    const attached = session.attachReady(stream);
    if (!attached.attached) {
      const state = denoiserFailureState(attached.reason);
      markUnavailable(attached.reason, attached.reason, state);
      return;
    }

    const processedTrack = attached.stream.getAudioTracks()[0];
    if (!processedTrack || processedTrack.readyState !== 'live') {
      markUnavailable('The denoised output track was not live when capture started.', 'denoised_output_track_unavailable', 'incomplete');
      void session.detach();
      return;
    }

    let recorder: MediaRecorder;
    try {
      if (!mimeType || !MediaRecorder.isTypeSupported(mimeType)) {
        throw new Error('The browser cannot record the denoised analysis stream in the original recording format.');
      }
      recorder = new MediaRecorder(attached.stream, { mimeType });
      if (recorder.mimeType && normalizeMimeType(recorder.mimeType) !== normalizeMimeType(mimeType)) {
        throw new Error('The denoised analysis stream selected a different recording format.');
      }
    } catch (error) {
      markUnavailable(error instanceof Error ? error.message : 'Denoised analysis capture could not start.', 'denoised_capture_start_failed');
      void session.detach();
      return;
    }

    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const capture: ActiveDenoisedCapture = {
      recorder,
      intentionalStop: false,
      session,
      done,
      finish,
      pendingChunks: [],
      pendingBytes: 0,
      writerReady: Promise.resolve()
    };
    denoisedCaptureRef.current = capture;

    const appendChunk = (chunk: Blob) => {
      if (!chunk.size || capture.failure) return;
      const writer = capture.writer;
      if (!writer) {
        capture.pendingBytes += chunk.size;
        if (capture.pendingBytes > 8 * 1024 * 1024) {
          capture.failure = {
            reason: 'Local storage did not become ready for denoised audio in time.',
            errorCode: 'denoised_sidecar_storage_delayed',
            state: 'failed'
          };
          if (recorder.state !== 'inactive') recorder.stop();
          return;
        }
        capture.pendingChunks.push(chunk);
        return;
      }
      void writer.append(chunk).catch((error) => {
        capture.failure = {
          reason: error instanceof Error ? error.message : 'The denoised audio could not be saved locally.',
          errorCode: 'denoised_audio_storage_failed',
          state: 'failed'
        };
        setNotice({ kind: 'info', text: 'The original recording is safe, but its denoised copy could not be saved. Pyannote will not receive the original audio for this recording.' });
        if (recorder.state !== 'inactive') recorder.stop();
      });
    };

    recorder.addEventListener('dataavailable', (event) => appendChunk(event.data));
    processedTrack.addEventListener('ended', () => {
      if (capture.intentionalStop || capture.failure) return;
      capture.failure = {
        reason: 'The denoised audio stream ended before recording was stopped.',
        errorCode: 'denoised_output_track_ended',
        state: 'incomplete'
      };
      setNotice({ kind: 'info', text: 'The original recording is continuing safely, but its denoised copy ended early and will not be analyzed.' });
      if (recorder.state !== 'inactive') recorder.stop();
    }, { once: true });
    recorder.addEventListener('error', () => {
      capture.failure = {
        reason: 'The browser could not record the denoised analysis stream.',
        errorCode: 'denoised_media_recorder_failed',
        state: 'failed'
      };
      if (recorder.state !== 'inactive') recorder.stop();
    }, { once: true });
    recorder.addEventListener('stop', () => {
      void (async () => {
        try {
          if (!capture.intentionalStop && !capture.failure) {
            capture.failure = {
              reason: 'The denoised audio recorder stopped unexpectedly.',
              errorCode: 'denoised_recorder_stopped_early',
              state: 'incomplete'
            };
          }
          await capture.writerReady;
          if (capture.failure) {
            if (capture.writer) await capture.writer.discard(capture.failure.reason, capture.failure.state, capture.failure.errorCode);
            else await recordingStore.markDenoisedAudioUnavailable(recordingId, capture.failure.reason, capture.failure.state, capture.failure.errorCode);
          } else if (session.qualificationState !== 'qualified') {
            if (capture.writer) {
              await capture.writer.discard(
                'Device performance qualification did not complete before this recording stopped.',
                'incomplete',
                'denoiser_qualification_pending'
              );
            } else {
              await recordingStore.markDenoisedAudioUnavailable(
                recordingId,
                'Device performance qualification did not complete before this recording stopped.',
                'incomplete',
                'denoiser_qualification_pending'
              );
            }
          } else if (capture.writer) {
            await capture.writer.finalize();
          }
        } catch (error) {
          if (capture.writer) {
            await capture.writer.discard(error instanceof Error ? error.message : 'Denoised analysis audio finalization failed.');
          } else {
            await recordingStore.markDenoisedAudioUnavailable(recordingId, 'Denoised analysis audio could not be finalized.', 'failed', 'denoised_audio_finalize_failed');
          }
        } finally {
          if (denoisedCaptureRef.current === capture) denoisedCaptureRef.current = null;
          await session.detach();
          capture.finish();
        }
      })();
    }, { once: true });

    capture.writerReady = recordingStore.createDenoisedAudioWriter(recordingId, mimeType).then(async (writer) => {
      capture.writer = writer;
      if (capture.failure) {
        await writer.discard(capture.failure.reason, capture.failure.state, capture.failure.errorCode);
        return;
      }
      const queued = capture.pendingChunks;
      capture.pendingChunks = [];
      capture.pendingBytes = 0;
      for (const chunk of queued) await writer.append(chunk);
    }).catch((error) => {
      capture.failure = {
        reason: error instanceof Error ? error.message : 'The denoised analysis file could not be opened.',
        errorCode: 'denoised_sidecar_storage_failed',
        state: 'failed'
      };
      setNotice({ kind: 'info', text: 'The original recording is safe, but its denoised copy could not be saved. Pyannote will not receive the original audio for this recording.' });
      if (recorder.state !== 'inactive') recorder.stop();
    });

    try {
      recorder.start(1000);
    } catch (error) {
      capture.failure = {
        reason: error instanceof Error ? error.message : 'The denoised analysis recorder could not start.',
        errorCode: 'denoised_media_recorder_start_failed',
        state: 'failed'
      };
      denoisedStateWriteRef.current = recordingStore.markDenoisedAudioUnavailable(recordingId, capture.failure.reason, 'failed', capture.failure.errorCode).catch(() => undefined);
      if (denoisedCaptureRef.current === capture) denoisedCaptureRef.current = null;
      void session.detach();
      capture.finish();
    }
  }

  async function handleStart() {
    setNotice(null);
    if (!support.supported) {
      setNotice({ kind: 'error', text: support.reason ?? 'This browser cannot save recordings to durable local storage.' });
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setNotice({ kind: 'error', text: 'This browser does not support microphone recording. Open the installed PWA in a current browser.' });
      return;
    }

    const denoiserSessionAtTap = denoiserSessionRef.current;
    const denoiserReadyAtTap = denoiserSessionAtTap?.state === 'ready';
    setRecorderState('starting');
    // This is called directly from the Record gesture. It is best-effort and
    // does not delay the original capture or wait for a pending model load.
    void denoiserSessionAtTap?.activate();
    try {
      const audioConstraints = denoiserReadyAtTap
        ? {
          ...(microphoneId ? { deviceId: { exact: microphoneId } } : {}),
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: false
        }
        : microphoneId ? { deviceId: { exact: microphoneId } } : true;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints
      });
      streamRef.current = stream;
      void refreshMicrophones().catch(() => undefined);
      const preferredMimeType = getPreferredMimeType();
      const recorder = preferredMimeType ? new MediaRecorder(stream, { mimeType: preferredMimeType }) : new MediaRecorder(stream);
      const mimeType = recorder.mimeType || preferredMimeType;
      if (!mimeType) throw new Error('The browser did not report its recording format. Try a current browser.');
      const startedAt = new Date().toISOString();
      const writer = await recordingStore.create({
        mimeType,
        consentRecordedAt: startedAt,
        startedAt
      });
      writerRef.current = writer;
      writeErrorRef.current = null;
      stopRequestedRef.current = false;
      stopReasonRef.current = 'user';
      pausedDurationRef.current = 0;
      pausedAtRef.current = 0;
      startedAtRef.current = Date.now();
      setElapsed(0);

      recorderRef.current = recorder;
      recorder.addEventListener('dataavailable', (event) => {
        if (!event.data.size || !writerRef.current) return;
        const activeWriter = writerRef.current;
        const checkpointAt = pausedAtRef.current || Date.now();
        const capturedSeconds = Math.max(0, Math.floor((checkpointAt - startedAtRef.current - pausedDurationRef.current) / 1000));
        void activeWriter.append(event.data).then(async () => {
          try {
            await recordingStore.checkpointCaptureDuration(activeWriter.recording.id, capturedSeconds);
          } catch {
            setNotice({ kind: 'info', text: 'Audio is still recording, but recovery progress could not be updated. Keep this screen open until you stop.' });
          }
        }).catch((error) => {
          writeErrorRef.current = error instanceof Error ? error.message : 'The audio chunk could not be saved.';
          setNotice({ kind: 'error', text: 'Local storage stopped accepting audio. The recording has been stopped to protect the saved file.' });
          if (recorder.state !== 'inactive') recorder.stop();
        });
      });
      recorder.addEventListener('stop', () => { void finalizeRecording(); }, { once: true });
      recorder.addEventListener('error', () => {
        writeErrorRef.current = 'The microphone recorder stopped unexpectedly. The saved audio is being kept as an incomplete recording.';
        const capture = denoisedCaptureRef.current;
        if (capture && !capture.failure) {
          capture.failure = { reason: 'The original microphone recorder failed.', errorCode: 'original_recorder_failed', state: 'incomplete' };
          if (capture.recorder.state !== 'inactive') capture.recorder.stop();
        }
        setNotice({ kind: 'error', text: 'The microphone stream ended unexpectedly. Check microphone permission and local storage.' });
        if (recorder.state !== 'inactive') recorder.stop();
      }, { once: true });
      for (const track of stream.getAudioTracks()) {
        track.addEventListener('ended', () => {
          if (stopRequestedRef.current || recorder.state === 'inactive') return;
          writeErrorRef.current = 'The microphone ended before recording was stopped. The saved audio is incomplete.';
          const capture = denoisedCaptureRef.current;
          if (capture && !capture.failure) {
            capture.failure = { reason: 'The microphone ended before recording was stopped.', errorCode: 'microphone_track_ended', state: 'incomplete' };
            if (capture.recorder.state !== 'inactive') capture.recorder.stop();
          }
          setNotice({ kind: 'error', text: 'The microphone disconnected. The saved original is being kept as an incomplete recording.' });
          try { recorder.stop(); } catch { /* The recorder may already have stopped with the track. */ }
        }, { once: true });
      }
      recorder.start(1000);
      setRecorderState('recording');
      if (denoiserReadyAtTap
        && denoiserSessionAtTap === denoiserSessionRef.current
        && denoiserSessionAtTap?.state === 'ready') {
        // This branch starts synchronously after the original recorder. Its
        // sidecar OPFS writer initializes in the background and buffers only
        // the first bounded recorder chunks while OPFS opens.
        startDenoisedCapture(writer.recording.id, stream, mimeType, denoiserSessionAtTap);
      } else {
        const reason = denoiserSessionAtTap?.reason
          ?? (denoiserSessionAtTap?.state === 'initializing' ? 'model_not_ready_at_record_tap' : 'denoiser_not_ready_at_record_tap');
        const state = denoiserFailureState(denoiserSessionAtTap?.reason);
        denoisedStateWriteRef.current = recordingStore.markDenoisedAudioUnavailable(
          writer.recording.id,
          reason,
          denoiserSessionAtTap?.reason ? state : 'failed',
          denoiserSessionAtTap?.reason ?? 'denoiser_not_ready_at_record_tap'
        ).catch(() => undefined);
        setNotice({
          kind: 'info',
          text: 'The original recording is active, but DeepFilterNet was not ready when recording started. Pyannote will not receive the original audio for this recording.'
        });
      }
      void startMeter(stream);
      if (!isPersistent) void recordingStore.requestDurability().then((value) => setIsPersistent(value)).catch(() => undefined);
      await refreshLocalState();
    } catch (error) {
      const failedCapture = denoisedCaptureRef.current;
      if (failedCapture && failedCapture.recorder.state !== 'inactive') {
        failedCapture.failure = { reason: 'Original recording startup failed.', errorCode: 'raw_recording_start_failed', state: 'failed' };
        failedCapture.recorder.stop();
        await failedCapture.done;
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      const writer = writerRef.current;
      if (writer) {
        writer.discard();
        await recordingStore.delete(writer.recording.id).catch(() => undefined);
        writerRef.current = null;
      }
      setRecorderState('ready');
      const message = error instanceof Error ? error.message : 'Recording could not be started.';
      const permissionDenied = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError');
      setNotice({ kind: 'error', text: permissionDenied
        ? 'Microphone permission was denied. Allow microphone access for this PWA, then try again.'
        : microphoneId && error instanceof DOMException && (error.name === 'OverconstrainedError' || error.name === 'NotFoundError')
          ? 'The selected microphone is unavailable. Reconnect it or choose System default.'
          : message });
      await refreshLocalState();
    }
  }

  async function finalizeRecording() {
    const writer = writerRef.current;
    if (!writer) return;
    if (!stopRequestedRef.current && !writeErrorRef.current) {
      writeErrorRef.current = 'The recording stopped unexpectedly. The available original audio is being kept as incomplete.';
    }
    const stopTime = pausedAtRef.current || Date.now();
    const durationSeconds = Math.max(0, Math.floor((stopTime - startedAtRef.current - pausedDurationRef.current) / 1000));
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    stopMeter();
    setRecorderState('stopping');

    let saved = false;
    try {
      const denoisedCapture = denoisedCaptureRef.current;
      if (denoisedCapture) {
        denoisedCapture.intentionalStop = stopRequestedRef.current;
        if (denoisedCapture.recorder.state !== 'inactive') denoisedCapture.recorder.stop();
        await denoisedCapture.done;
      }
      await denoisedStateWriteRef.current?.catch(() => undefined);
      if (writeErrorRef.current) throw new Error(writeErrorRef.current);
      const recording = await writer.finalize(durationSeconds);
      if (recording.byteLength === 0) {
        await recordingStore.delete(recording.id);
        setNotice({ kind: 'error', text: 'No audio was captured. Check microphone permission and try again.' });
      } else {
        saved = true;
        setNotice({ kind: 'success', text: stopReasonRef.current === 'limit'
          ? `Recording stopped at ${formatElapsed(FIELD_CAPTURE_STOP_SECONDS).slice(1).join(':')} to stay within the transcription limit. The original was saved on this phone.`
          : 'Recording saved on this phone. Find it in History.' });
      }
    } catch (error) {
      await recordingStore.recoverInterrupted().catch(() => undefined);
      setNotice({ kind: 'error', text: `Could not save the recording. Check History for any recovered audio. ${error instanceof Error ? error.message : ''}`.trim() });
    } finally {
      recorderRef.current = null;
      writerRef.current = null;
      pausedAtRef.current = 0;
      stopRequestedRef.current = false;
      stopReasonRef.current = 'user';
      setRecorderState('ready');
      void refreshLocalState();
    }
    if (saved && navigator.onLine) void syncRef.current?.process().catch(() => undefined);
  }

  function handlePause() {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== 'recording') return;
    recorder.pause();
    const denoisedRecorder = denoisedCaptureRef.current?.recorder;
    if (denoisedRecorder?.state === 'recording') denoisedRecorder.pause();
    pausedAtRef.current = Date.now();
    setElapsed(Math.max(0, Math.floor((pausedAtRef.current - startedAtRef.current - pausedDurationRef.current) / 1000)));
    setRecorderState('paused');
    cancelAnimationFrame(meterFrameRef.current);
    setMeterLevels(initialMeter.map(() => 0.15));
  }

  function handleResume() {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== 'paused') return;
    pausedDurationRef.current += Date.now() - pausedAtRef.current;
    pausedAtRef.current = 0;
    recorder.resume();
    const denoisedRecorder = denoisedCaptureRef.current?.recorder;
    if (denoisedRecorder?.state === 'paused') denoisedRecorder.resume();
    setRecorderState('recording');
    if (streamRef.current) void startMeter(streamRef.current);
  }

  function handleStop(reason: 'user' | 'limit' = 'user') {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive' || stopRequestedRef.current) return;
    stopRequestedRef.current = true;
    stopReasonRef.current = reason;
    if (reason === 'limit') {
      setNotice({ kind: 'info', text: 'This recording reached the supported transcription length and is stopping safely.' });
    }
    setRecorderState('stopping');
    const denoisedRecorder = denoisedCaptureRef.current?.recorder;
    if (denoisedCaptureRef.current) denoisedCaptureRef.current.intentionalStop = true;
    if (denoisedRecorder && denoisedRecorder.state !== 'inactive') denoisedRecorder.stop();
    recorder.stop();
  }

  async function handlePlay(recording: LocalRecording) {
    if (playingId === recording.id) {
      setPlayingId(null);
      setAudioUrl(null);
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
      return;
    }
    try {
      const file = await recordingStore.readAudio(recording.id);
      const nextUrl = URL.createObjectURL(file);
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = nextUrl;
      setAudioUrl(nextUrl);
      setPlayingId(recording.id);
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'This local recording could not be opened.' });
    }
  }

  async function handleRetryUpload(recording: LocalRecording) {
    try {
      await recordingStore.retryUpload(recording.id);
      await refreshLocalState();
      if (navigator.onLine) await syncRef.current?.process();
      await refreshLocalState();
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'This recording could not be queued for upload.' });
    }
  }

  async function handleDiscardIncomplete(recording: LocalRecording) {
    if (recording.localState !== 'incomplete') return;
    const label = recording.outletName || 'this recording';
    if (!window.confirm(`Delete the incomplete audio for ${label} from this phone? This cannot be undone.`)) return;
    try {
      await recordingStore.delete(recording.id);
      await refreshLocalState();
      setRecovery((current) => current ? ({
        ...current,
        items: current.items.filter((item) => item.id !== recording.id),
        incompleteCount: Math.max(0, current.incompleteCount - 1)
      }) : current);
      setNotice({ kind: 'success', text: 'Incomplete recording deleted from this phone.' });
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'The incomplete recording could not be deleted.' });
    }
  }

  const connectionLabel = !online ? 'Offline' : apiHealth ? 'Online' : 'Sync unavailable';
  const storageDriver = apiHealth?.runtime.storageDriver;
  const storageAvailable = storageDriver === 'local' || storageDriver === 's3';
  const storageDestination = storageDriver === 's3' ? 'S3' : storageDriver === 'local' ? 'the API server' : 'the configured server storage';
  const uploadLabel = storageAvailable
    ? online ? `Sync to ${storageDestination} is ready` : `Waiting for connection to sync to ${storageDestination}`
    : online ? 'Checking recording service' : 'Offline · recordings stay on this device';

  return <div className="app-shell">
    <header className="field-topbar">
      <a className="brand-lockup" href="#capture" onClick={(event) => { event.preventDefault(); setScreen('capture'); }} aria-label="Field Source capture">
        <span className="brand-mark">FS</span><span>Field Source</span>
      </a>
      <nav className="bottom-nav" aria-label="Primary navigation">
        <button type="button" className={screen === 'capture' ? 'active' : ''} aria-current={screen === 'capture' ? 'page' : undefined} onClick={() => setScreen('capture')}><Icon name="record"/>Record</button>
        <button type="button" className={screen === 'history' ? 'active' : ''} aria-current={screen === 'history' ? 'page' : undefined} disabled={recorderState !== 'ready'} onClick={() => setScreen('history')}><Icon name="history"/>History</button>
      </nav>
      <span className={`connection ${online ? 'connected' : 'disconnected'}`}><i/>{connectionLabel}</span>
    </header>

    <main className="field-main">
      {notice && <div className={`notice notice-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'} aria-live={notice.kind === 'error' ? 'assertive' : 'polite'}>{notice.text}<button type="button" aria-label="Dismiss message" onClick={() => setNotice(null)}><Icon name="close"/></button></div>}
      {storageError && <div className="notice notice-error" role="alert">{storageError}</div>}
      {storage?.quota && storage.quota - (storage.usage ?? 0) < 50_000_000 && <div className="storage-warning" role="status">Local storage is getting low. Free space before recording another long visit.</div>}
      {screen === 'capture' ? <div className="capture-layout">
        <h1 className="capture-title">Record a conversation</h1>
        <section className="capture-options" aria-label="Recording setup">
          {!support.supported && <p role="alert">{support.reason}</p>}
          {typeof navigator.mediaDevices?.getUserMedia === 'function' && <div className="microphone-field">
            <label>Microphone
              <select value={microphoneId} onChange={(event) => setMicrophoneId(event.target.value)} disabled={recorderState !== 'ready' || checkingMicrophones}>
                <option value="">System default</option>
                {microphoneId && !microphones.some((device) => device.deviceId === microphoneId)
                  && <option value={microphoneId}>Selected microphone disconnected</option>}
                {microphones.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
              </select>
            </label>
            <button type="button" onClick={() => { void handleCheckMicrophones(); }} disabled={recorderState !== 'ready' || checkingMicrophones}>
              {checkingMicrophones ? 'Checking…' : 'Show available microphones'}
            </button>
          </div>}

        </section>

        <section className={`recorder-panel ${recorderState === 'recording' ? 'is-recording' : ''} ${recorderState === 'paused' ? 'is-paused' : ''}`} aria-label="Recording controls">
          <div className="recorder-head"><span className={`recorder-state state-${recorderState}`} role="status"><i/>{recorderState === 'starting' ? 'Starting' : recorderState === 'recording' ? 'Recording' : recorderState === 'paused' ? 'Paused' : recorderState === 'stopping' ? 'Saving' : 'Ready'}</span></div>
          <div className="timer" aria-label={`Elapsed time ${hours}:${minutes}:${seconds}`}><span className="timer-tile">{hours}</span><span className="timer-separator">:</span><span className="timer-tile">{minutes}</span><span className="timer-separator">:</span><span className="timer-tile">{seconds}</span></div>
          {(recorderState === 'recording' || recorderState === 'paused') && elapsed >= FIELD_CAPTURE_WARNING_SECONDS && <p className="capture-limit-warning" role="status">Transcription supports up to 10 minutes. Recording will stop at 9:50 to leave a safety margin.</p>}
          <div className="level-meter" aria-label={recorderState === 'recording' ? 'Microphone audio level' : 'Audio level meter'}>
            {meterLevels.map((level, index) => <i key={index} style={{ height: `${Math.round(level * 34)}px` }}/>) }
          </div>
          {recorderState === 'recording' || recorderState === 'paused' ? (
            <div className="transport-controls">
              {recorderState === 'paused'
                ? <button type="button" onClick={handleResume}><Icon name="play"/>Resume</button>
                : <button type="button" onClick={handlePause}><Icon name="pause"/>Pause</button>}
              <button type="button" onClick={() => handleStop()}><Icon name="stop"/>Stop recording</button>
            </div>
          ) : (
            <>
              {recorderState === 'ready' && <p className="recording-consent" id="recording-consent">Get permission before recording. By tapping Start, you confirm everyone agreed.</p>}
              <button className="start-button" type="button" onClick={() => { void handleStart(); }} disabled={!canStart} aria-describedby={recorderState === 'ready' ? 'recording-consent' : undefined}>
                <Icon name="mic"/>{recorderState === 'starting' ? 'Opening microphone…' : recorderState === 'stopping' ? 'Saving…' : 'Start recording'}
              </button>
            </>
          )}
          <div className="recorder-foot"><span><Icon name="save"/>Audio saves to this phone</span></div>
        </section>

        <StorageBreakdown snapshot={storage} onProtect={() => { void handleEnablePersistence(); }}/>
      </div> : <section className="history-screen">
        <div className="history-title"><div><h1>Recording history</h1><p>Audio saved on this phone.</p></div><span className="history-total">{displayRecords.length}</span></div>
        <StorageBreakdown snapshot={storage}/>
        {displayRecords.length ? <div className="full-history">{displayRecords.map((recording) => <RecordingRow key={recording.id} recording={recording} playingId={playingId} audioUrl={audioUrl} onPlay={(item) => { void handlePlay(item); }} storageAvailable={storageAvailable} storageDriver={storageDriver} onRetry={(item) => { void handleRetryUpload(item); }} onDeleteIncomplete={(item) => { void handleDiscardIncomplete(item); }}/>)}</div>
        : <div className="empty-screen"><span className="empty-icon"><Icon name="history"/></span><h2>No recordings yet</h2><p>Start a recording to save it here.</p><button className="text-button" type="button" onClick={() => setScreen('capture')}>Return to capture</button></div>}
        {recovery?.items.length ? <div className="recovery-note"><strong>Interrupted captures</strong>{recovery.items.map((item) => <p key={item.id}>{item.message}</p>)}</div> : null}
        <div className="history-footnote"><strong>Media upload</strong><span>{storageAvailable ? `Audio syncs to ${storageDestination} after the device comes online; one local OPFS copy stays on this device.` : `${uploadLabel}. Recordings stay in OPFS until the API is reachable.`}</span><strong>Conversation analysis</strong><span>{apiHealth?.runtime.analysis === 'not-configured' ? 'Transcription is not configured.' : 'Transcription status appears after audio is stored.'}</span></div>
      </section>}
    </main>

    {screen === 'history' && chunkQueue.length > 0 && <section className="chunk-upload-queue" aria-label="Audio upload chunks" aria-live="polite">
      <div className="chunk-queue-heading"><strong>Sending recording data</strong><span>{chunkQueue.some((item) => item.state === 'uploading') ? `Transport chunks · final file goes to ${storageDestination}` : 'Recent transfers'}</span></div>
      {chunkQueue.map((item) => <div className="chunk-queue-row" key={item.recordingId}>
        <span className="chunk-queue-name">{item.outletName || 'Field recording'}</span>
        <div className="chunk-queue-segments" aria-label={`${item.completedChunks} of ${item.totalChunks} chunks uploaded`}>
          {Array.from({ length: item.totalChunks }, (_, index) => <i key={index} className={index < item.completedChunks ? 'sent' : item.state === 'error' && index === item.completedChunks ? 'failed' : ''}/>) }
        </div>
        <span className="chunk-queue-count">{item.state === 'complete' ? 'Saved' : item.state === 'error' ? 'Retry' : `${item.completedChunks}/${item.totalChunks}`}</span>
      </div>)}
    </section>}
    {screen === 'history' && <footer className="truth-footer"><span>{uploadLabel}</span><span>{apiHealth?.runtime.analysis === 'not-configured' ? 'Transcription unavailable' : 'Analysis follows upload'}</span></footer>}
  </div>;
}

if (import.meta.env.DEV && window.location.pathname === '/__noise-fixtures') {
  const { NoiseFixtureRunner } = await import('./dev/noise-fixture-runner');
  createRoot(document.getElementById('root')!).render(<NoiseFixtureRunner/>);
} else {
  registerFieldServiceWorker();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <FieldApp/>
    </StrictMode>
  );
}
