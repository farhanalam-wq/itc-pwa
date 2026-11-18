import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createApiClient } from '@itc/api-client';
import '@fontsource-variable/hanken-grotesk';
import { registerFieldServiceWorker } from './pwa/register-service-worker';
import {
  getOpfsSupport,
  recordingStore,
  type LocalRecording,
  type RecordingWriter,
  type RecoveryReport,
  type StorageSnapshot
} from './storage';
import { startMetadataRegistrationSync, type MetadataRegistrationSyncController } from './sync/metadata-registration';
import './styles.css';

type Screen = 'capture' | 'history';
type RecorderState = 'ready' | 'starting' | 'recording' | 'paused' | 'stopping';
type Notice = { kind: 'info' | 'success' | 'error'; text: string };

const apiClient = createApiClient({ baseUrl: import.meta.env.VITE_API_BASE_URL || '/api' });
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
    return <span className="metadata-state failed" title={recording.metadataRegistrationError}>Manager link needs retry</span>;
  }
  if (recording.metadataRegistrationState === 'registering') {
    return <span className="metadata-state">Linking visit details</span>;
  }
  return <span className="metadata-state">Visit details queued</span>;
}

function RecordingRow({
  recording,
  playingId,
  audioUrl,
  onPlay
}: {
  recording: LocalRecording;
  playingId: string | null;
  audioUrl: string | null;
  onPlay: (recording: LocalRecording) => void;
}) {
  const localOnly = recording.syncState !== 'uploaded';
  return <article className="recording-row">
    <div className="row-main">
      <div className="row-title"><strong>{recording.outletName}</strong><span>{recording.localState === 'incomplete' ? 'Incomplete' : 'On this phone'}</span></div>
      <div className="row-meta"><time dateTime={recording.startedAt}>{formatDateTime(recording.startedAt)}</time><span>{formatElapsed(recording.durationSeconds).slice(1).join(':')}</span><span>{formatBytes(recording.byteLength)}</span></div>
      <div className="row-states"><span className={localOnly ? 'audio-state local' : 'audio-state uploaded'}>{localOnly ? 'S3 upload unavailable' : 'Audio uploaded'}</span><MetadataState recording={recording}/></div>
      {recording.localState === 'incomplete' && recording.incompleteReason && <p className="row-warning">{recording.incompleteReason}</p>}
      {playingId === recording.id && audioUrl && <audio className="audio-player" controls autoPlay src={audioUrl} aria-label={`Local recording from ${recording.outletName}`} onEnded={() => onPlay(recording)}/>}
    </div>
    {recording.byteLength > 0 && <button className="listen-button" type="button" onClick={() => onPlay(recording)} aria-label={`${playingId === recording.id ? 'Close' : 'Play'} local recording from ${recording.outletName}`}>
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
  const [outletName, setOutletName] = useState('');
  const [representativeId, setRepresentativeId] = useState('');
  const [territoryId, setTerritoryId] = useState('');
  const [consent, setConsent] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [meterLevels, setMeterLevels] = useState(initialMeter);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [isPersistent, setIsPersistent] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const writerRef = useRef<RecordingWriter | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const startedAtRef = useRef(0);
  const pausedAtRef = useRef(0);
  const pausedDurationRef = useRef(0);
  const writeErrorRef = useRef<string | null>(null);
  const syncRef = useRef<MetadataRegistrationSyncController | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const meterSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const meterAnalyserRef = useRef<AnalyserNode | null>(null);
  const meterFrameRef = useRef(0);
  const lastMeterUpdateRef = useRef(0);
  const audioUrlRef = useRef<string | null>(null);

  const canStart = support.supported
    && Boolean(outletName.trim() && representativeId.trim() && territoryId.trim())
    && consent
    && recorderState === 'ready';
  const queueCount = useMemo(() => records.filter((record) => record.localState === 'ready' && record.syncState === 'queued').length, [records]);
  const orderedRecords = useMemo(() => [...records].sort((a, b) => b.startedAt.localeCompare(a.startedAt)), [records]);
  const displayRecords = orderedRecords.filter((record) => record.localState !== 'recording');
  const [hours, minutes, seconds] = formatElapsed(elapsed);

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
    if (!navigator.onLine) {
      setApiHealth(null);
      return;
    }
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

    const sync = startMetadataRegistrationSync(apiClient);
    syncRef.current = sync;
    const onOnline = () => {
      setOnline(true);
      void refreshApiHealth();
      void refreshLocalState();
    };
    const onOffline = () => {
      setOnline(false);
      setApiHealth(null);
    };
    const retryTimer = window.setInterval(() => {
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

  async function handleStart() {
    setNotice(null);
    if (!support.supported) {
      setNotice({ kind: 'error', text: support.reason ?? 'This browser cannot save recordings to durable local storage.' });
      return;
    }
    if (!consent) {
      setNotice({ kind: 'error', text: 'Confirm the shopkeeper’s consent before recording.' });
      return;
    }
    if (!outletName.trim() || !representativeId.trim() || !territoryId.trim()) {
      setNotice({ kind: 'error', text: 'Add the outlet, representative, and territory before starting.' });
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setNotice({ kind: 'error', text: 'This browser does not support microphone recording. Open the installed PWA in a current browser.' });
      return;
    }

    setRecorderState('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      streamRef.current = stream;
      const mimeType = getPreferredMimeType();
      const startedAt = new Date().toISOString();
      const writer = await recordingStore.create({
        outletName: outletName.trim(),
        representativeId: representativeId.trim(),
        territoryId: territoryId.trim(),
        mimeType: mimeType ?? 'audio/webm',
        consentRecordedAt: startedAt,
        startedAt
      });
      writerRef.current = writer;
      writeErrorRef.current = null;
      pausedDurationRef.current = 0;
      pausedAtRef.current = 0;
      startedAtRef.current = Date.now();
      setElapsed(0);

      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.addEventListener('dataavailable', (event) => {
        if (!event.data.size || !writerRef.current) return;
        void writerRef.current.append(event.data).catch((error) => {
          writeErrorRef.current = error instanceof Error ? error.message : 'The audio chunk could not be saved.';
          setNotice({ kind: 'error', text: 'Local storage stopped accepting audio. The recording has been stopped to protect the saved file.' });
          if (recorder.state !== 'inactive') recorder.stop();
        });
      });
      recorder.addEventListener('stop', () => { void finalizeRecording(); }, { once: true });
      recorder.addEventListener('error', () => {
        setNotice({ kind: 'error', text: 'The microphone stream ended unexpectedly. Check microphone permission and local storage.' });
        if (recorder.state !== 'inactive') recorder.stop();
      }, { once: true });
      recorder.start(1000);
      setRecorderState('recording');
      void startMeter(stream);
      if (!isPersistent) void recordingStore.requestDurability().then((value) => setIsPersistent(value)).catch(() => undefined);
      await refreshLocalState();
    } catch (error) {
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
        : message });
      await refreshLocalState();
    }
  }

  async function finalizeRecording() {
    const writer = writerRef.current;
    if (!writer) return;
    const stopTime = pausedAtRef.current || Date.now();
    const durationSeconds = Math.max(0, Math.floor((stopTime - startedAtRef.current - pausedDurationRef.current) / 1000));
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    stopMeter();
    setRecorderState('stopping');

    try {
      if (writeErrorRef.current) throw new Error(writeErrorRef.current);
      const saved = await writer.finalize(durationSeconds);
      writerRef.current = null;
      if (saved.byteLength === 0) {
        await recordingStore.delete(saved.id);
        setNotice({ kind: 'error', text: 'No audio was captured. Check microphone permission and record the visit again.' });
        setRecorderState('ready');
        await refreshLocalState();
        return;
      }
      setNotice({ kind: 'success', text: online
        ? 'Audio saved on this phone. Visit details will register with the manager API; S3 upload is not configured.'
        : 'Audio saved on this phone. Visit details will register when you are online; audio remains local until S3 is configured.' });
      setRecorderState('ready');
      await refreshLocalState();
      if (navigator.onLine) {
        const result = await syncRef.current?.process();
        if (result?.failures.length) {
          setNotice({ kind: 'info', text: 'Audio is safe on this phone. Manager visit details will retry when the API is reachable.' });
        }
        await refreshApiHealth();
        await refreshLocalState();
      }
    } catch (error) {
      await recordingStore.recoverInterrupted().catch(() => undefined);
      setNotice({ kind: 'error', text: `The recording could not be finalized. Any saved audio remains on this phone for review. ${error instanceof Error ? error.message : ''}`.trim() });
      setRecorderState('ready');
      await refreshLocalState();
    } finally {
      recorderRef.current = null;
      writerRef.current = null;
      pausedAtRef.current = 0;
      void refreshApiHealth();
    }
  }

  function handlePause() {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== 'recording') return;
    recorder.pause();
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
    setRecorderState('recording');
    if (streamRef.current) void startMeter(streamRef.current);
  }

  function handleStop() {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    setRecorderState('stopping');
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

  const statusTitle = !support.supported ? 'LOCAL STORAGE UNAVAILABLE'
    : !online ? 'OFFLINE · READY TO RECORD'
      : 'READY TO RECORD';
  const statusDetail = !support.supported ? support.reason
    : isPersistent ? 'Recordings are protected in this device’s private storage'
      : 'Capture works offline after this PWA is installed and opened once';
  const connectionLabel = !online ? 'Offline · local save'
    : apiHealth ? 'Manager API online'
      : 'Manager API unavailable';
  const uploadLabel = apiHealth?.runtime.uploads === 'not-configured'
    ? 'S3 upload unavailable'
    : 'Audio stays on this phone';

  return <div className="app-shell">
    <header className="field-topbar">
      <a className="brand-lockup" href="#capture" onClick={(event) => { event.preventDefault(); setScreen('capture'); }} aria-label="Field Source capture">
        <span className="brand-mark">FS</span><span>Field Source</span>
      </a>
      <span className={`connection ${online ? 'connected' : 'disconnected'}`}><i/>{connectionLabel}</span>
    </header>

    <main className="field-main">
      {screen === 'capture' ? <>
        <section className="readiness" aria-label="Recording readiness and upload status">
          <Icon name="shield"/>
          <div className="readiness-copy"><strong>{statusTitle}</strong><small>{statusDetail}</small></div>
          <span className={`queue-count ${queueCount ? 'has-queue' : ''}`}>{queueCount} local</span>
        </section>

        <div className="visit-heading"><div><h1>New recording</h1><p>{outletName.trim() || 'Add the shop you’re visiting'}{territoryId.trim() ? ` · ${territoryId.trim()}` : ''}</p></div><button className="history-link" type="button" onClick={() => setScreen('history')}><Icon name="history"/>History</button></div>

        <section className="visit-context" aria-label="Visit details">
          <label className="outlet-field">Outlet<input value={outletName} onChange={(event) => setOutletName(event.target.value)} placeholder="Shop or outlet name" autoComplete="organization" disabled={recorderState !== 'ready'}/></label>
          <div className="context-grid">
            <label>Representative<input value={representativeId} onChange={(event) => setRepresentativeId(event.target.value)} placeholder="Your name or ID" autoComplete="name" disabled={recorderState !== 'ready'}/></label>
            <label>Territory<input value={territoryId} onChange={(event) => setTerritoryId(event.target.value)} placeholder="Route or area" disabled={recorderState !== 'ready'}/></label>
          </div>
          <label className="consent-check"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={recorderState !== 'ready'}/><span>The shopkeeper agrees to this conversation being recorded.</span></label>
        </section>

        <section className={`recorder-panel ${recorderState === 'recording' ? 'is-recording' : ''} ${recorderState === 'paused' ? 'is-paused' : ''}`} aria-label="Recording controls">
          <div className="recorder-head"><span className="session-label">ON-DEVICE SESSION</span><span className={`recorder-state state-${recorderState}`}><i/>{recorderState === 'starting' ? 'Starting' : recorderState === 'recording' ? 'Recording' : recorderState === 'paused' ? 'Paused' : recorderState === 'stopping' ? 'Saving' : 'Ready'}</span></div>
          <div className="timer" aria-label={`Elapsed time ${hours}:${minutes}:${seconds}`}><span className="timer-tile">{hours}</span><span className="timer-separator">:</span><span className="timer-tile">{minutes}</span><span className="timer-separator">:</span><span className="timer-tile">{seconds}</span></div>
          <div className="level-meter" aria-label={recorderState === 'recording' ? 'Microphone audio level' : 'Audio level meter'}>
            {meterLevels.map((level, index) => <i key={index} style={{ height: `${Math.round(level * 34)}px` }}/>) }
          </div>
          <button className="start-button" type="button" onClick={() => { void handleStart(); }} disabled={!canStart}>
            <Icon name="mic"/>{recorderState === 'starting' ? 'Opening microphone…' : recorderState === 'recording' ? 'Recording in progress' : recorderState === 'paused' ? 'Recording paused' : recorderState === 'stopping' ? 'Saving to this phone…' : 'Start recording'}
          </button>
          <div className="transport-controls">
            {recorderState === 'paused'
              ? <button type="button" onClick={handleResume}><Icon name="play"/>Resume</button>
              : <button type="button" onClick={handlePause} disabled={recorderState !== 'recording'}><Icon name="pause"/>Pause</button>}
            <button type="button" onClick={handleStop} disabled={recorderState !== 'recording' && recorderState !== 'paused'}><Icon name="stop"/>Stop</button>
          </div>
          <div className="recorder-foot"><span><Icon name="save"/>Audio saves to this phone</span><span>{uploadLabel}</span></div>
        </section>

        {notice && <div className={`notice notice-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'} aria-live={notice.kind === 'error' ? 'assertive' : 'polite'}>{notice.text}<button type="button" aria-label="Dismiss message" onClick={() => setNotice(null)}><Icon name="close"/></button></div>}
        {storageError && <div className="notice notice-error" role="alert">{storageError}</div>}
        {storage?.quota && storage.quota - (storage.usage ?? 0) < 50_000_000 && <div className="storage-warning" role="status">Local storage is getting low. Free space before recording another long visit.</div>}
        {recovery?.items.length ? <div className="recovery-note" role="status"><strong>{recovery.incompleteCount + recovery.missingCount + recovery.unreadableCount} interrupted recording{recovery.items.length === 1 ? '' : 's'} found</strong><span>Saved files remain local and are excluded from upload until reviewed.</span></div> : null}

        <section className="recent-list" aria-label="Recent local recordings">
          <div className="list-heading"><h2>Recent recordings</h2>{storage && !storage.persistent
            ? <button className="storage-prompt" type="button" onClick={() => { void handleEnablePersistence(); }}>Protect local audio</button>
            : <span>{displayRecords.length ? `${displayRecords.length} on this phone` : 'No recordings yet'}</span>}</div>
          {displayRecords.length ? displayRecords.slice(0, 3).map((recording) => <RecordingRow key={recording.id} recording={recording} playingId={playingId} audioUrl={audioUrl} onPlay={(item) => { void handlePlay(item); }}/> )
            : <p className="empty-history">Stopped recordings appear here with their local-save and manager-link status.</p>}
        </section>
      </> : <section className="history-screen">
        <div className="history-title"><div><h1>Recording history</h1><p>Audio and visit details saved on this device.</p></div><span className="history-total">{displayRecords.length}</span></div>
        {displayRecords.length ? <div className="full-history">{displayRecords.map((recording) => <RecordingRow key={recording.id} recording={recording} playingId={playingId} audioUrl={audioUrl} onPlay={(item) => { void handlePlay(item); }}/>)}</div>
          : <div className="empty-screen"><span className="empty-icon"><Icon name="history"/></span><h2>No recordings yet</h2><p>Start a consented shop visit. The audio will be saved here before any upload is available.</p><button className="text-button" type="button" onClick={() => setScreen('capture')}>Return to capture</button></div>}
        {recovery?.items.length ? <div className="recovery-note"><strong>Interrupted captures</strong>{recovery.items.map((item) => <p key={item.id}>{item.message}</p>)}</div> : null}
        <div className="history-footnote"><strong>Media upload</strong><span>{uploadLabel}. New recordings will remain in OPFS while S3 is unconfigured.</span><strong>Conversation analysis</strong><span>{apiHealth?.runtime.analysis === 'not-configured' ? 'Transcription and insight extraction are not configured.' : 'Analysis state appears after audio is uploaded.'}</span></div>
      </section>}
    </main>

    <nav className="bottom-nav" aria-label="Primary navigation">
      <button type="button" className={screen === 'capture' ? 'active' : ''} aria-current={screen === 'capture' ? 'page' : undefined} onClick={() => setScreen('capture')}><Icon name="record"/>Record</button>
      <button type="button" className={screen === 'history' ? 'active' : ''} aria-current={screen === 'history' ? 'page' : undefined} onClick={() => setScreen('history')}><Icon name="history"/>History</button>
    </nav>
    <footer className="truth-footer"><span>{uploadLabel}</span><span>{apiHealth?.runtime.analysis === 'not-configured' ? 'Transcription unavailable' : 'Analysis follows upload'}</span></footer>
  </div>;
}

registerFieldServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FieldApp/>
  </StrictMode>
);
