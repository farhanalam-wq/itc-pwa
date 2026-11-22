import { useEffect, useRef, useState } from 'react';
import { createApiClient } from '@itc/api-client';
import { createDeepFilterSession, type DeepFilterTelemetryEvent } from '../audio/deepfilter-session';
import './noise-fixture-runner.css';

type FixtureState = 'waiting' | 'denoising' | 'uploading original' | 'uploading denoised audio' | 'queued for analysis' | 'failed';
interface FixtureResult {
  name: string;
  state: FixtureState;
  recordingId?: string;
  detail?: string;
  telemetry: string[];
}

const SAMPLE_RATE = 48_000;
const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || '/api';
const apiOrigin = new URL(apiBaseUrl, window.location.href);
const localHostnames = new Set(['localhost', '127.0.0.1', '[::1]']);
const apiClient = createApiClient({ baseUrl: apiBaseUrl, requestTimeoutMs: 60_000 });

function mimeTypeForRecorder(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
    .find((type) => MediaRecorder.isTypeSupported(type));
}

function fixtureOrder(name: string): number {
  const order = ['clean_reference.wav', 'noise_80.wav', 'noise_100.wav', 'noise_125.wav', 'noise_150.wav'];
  const index = order.indexOf(name.toLowerCase());
  return index === -1 ? order.length : index;
}

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function prettyTelemetry(event: DeepFilterTelemetryEvent): string {
  switch (event.type) {
    case 'initialization_started': return 'DeepFilterNet initialization started';
    case 'capability_check': return event.supported ? 'Browser audio capabilities passed' : `Unsupported: ${event.reason}`;
    case 'model_initialized': return `Model ready in ${(event.latencyMs / 1000).toFixed(1)}s`;
    case 'qualification_cache': return event.cacheHit ? `Qualification cache hit (p95 ${event.p95Load?.toFixed(3) ?? 'unknown'})` : 'No cached qualification; measuring this run';
    case 'load_report': return `Processing load: p95 ${event.report.p95Load.toFixed(3)}${event.qualified ? ' · qualified' : ' · failed qualification'}`;
    case 'overload': return `Overload at load ${event.load.toFixed(3)}`;
    case 'fallback': return `Denoiser fallback: ${event.reason}${event.message ? ` · ${event.message}` : ''}`;
    case 'resource_cleanup': return `Audio resources cleaned up · ${event.processedTracksStopped} processed track(s) stopped`;
  }
}

async function denoiseFixture(file: File, report: (event: DeepFilterTelemetryEvent) => void): Promise<Blob> {
  if (!window.isSecureContext || !('AudioWorkletNode' in window) || typeof MediaRecorder === 'undefined') {
    throw new Error('This browser does not support the secure AudioWorklet and MediaRecorder APIs required for this run.');
  }
  const mimeType = mimeTypeForRecorder();
  if (!mimeType) throw new Error('This browser has no supported audio recording format for the processed sidecar.');

  const sourceContext = new AudioContext({ sampleRate: SAMPLE_RATE });
  let session: ReturnType<typeof createDeepFilterSession> | undefined;
  let source: AudioBufferSourceNode | undefined;
  let recorder: MediaRecorder | undefined;
  let inputStream: MediaStream | undefined;
  const chunks: Blob[] = [];
  let fallbackReason: string | undefined;
  try {
    await sourceContext.resume();
    if (sourceContext.sampleRate !== SAMPLE_RATE || sourceContext.state !== 'running') {
      throw new Error('This browser could not provide a running 48 kHz Web Audio context.');
    }
    const audioBuffer = await sourceContext.decodeAudioData(await file.arrayBuffer());
    if (audioBuffer.duration < 12) throw new Error('Fixture is too short for the DeepFilterNet load qualification period.');
    const input = sourceContext.createMediaStreamDestination();
    inputStream = input.stream;
    session = createDeepFilterSession({
      onTelemetry: (event) => {
        report(event);
        if (event.type === 'fallback' || event.type === 'overload') {
          fallbackReason = event.type === 'fallback' ? event.reason : 'DeepFilterNet overload';
          if (source && sourceContext.state === 'running') {
            try { source.stop(); } catch { /* Already ended. */ }
          }
          if (recorder && recorder.state !== 'inactive') recorder.stop();
        }
      }
    });
    const activate = session.activate();
    const initialized = await session.ready;
    if (initialized.state !== 'ready') throw new Error(`DeepFilterNet initialization failed: ${initialized.reason ?? 'unknown reason'}.`);
    if (!await activate) throw new Error('The browser did not activate the DeepFilterNet AudioContext. Retry from this page.');

    const attached = session.attachReady(input.stream);
    if (!attached.attached) throw new Error(`Could not connect the fixture to DeepFilterNet: ${attached.reason}.`);
    source = sourceContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(input);
    recorder = new MediaRecorder(attached.stream, { mimeType });
    const completed = new Promise<Blob>((resolve, reject) => {
      recorder!.addEventListener('dataavailable', (event) => {
        if (event.data.size) chunks.push(event.data);
      });
      recorder!.addEventListener('error', () => reject(new Error('The browser could not record the denoised audio sidecar.')), { once: true });
      recorder!.addEventListener('stop', () => {
        if (fallbackReason) reject(new Error(`Denoising stopped: ${fallbackReason}.`));
        else resolve(new Blob(chunks, { type: recorder!.mimeType || mimeType }));
      }, { once: true });
      source!.addEventListener('ended', () => {
        if (recorder!.state !== 'inactive') recorder!.stop();
      }, { once: true });
    });
    recorder.start(1000);
    source.start();
    const blob = await completed;
    if (session.state !== 'ready' || session.qualificationState !== 'qualified') {
      throw new Error(`DeepFilterNet did not qualify this device for the run${session.reason ? `: ${session.reason}` : '.'}`);
    }
    if (!blob.size) throw new Error('DeepFilterNet produced an empty audio sidecar.');
    return blob;
  } catch (error) {
    fallbackReason = error instanceof Error ? error.message : 'Unknown denoiser failure';
    if (source && sourceContext.state === 'running') {
      try { source.stop(); } catch { /* Already ended. */ }
    }
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    throw error;
  } finally {
    source?.disconnect();
    for (const track of inputStream?.getTracks() ?? []) track.stop();
    await session?.dispose();
    await sourceContext.close().catch(() => undefined);
  }
}

async function uploadFixture(file: File, processed: Blob, setState: (state: FixtureState) => void): Promise<string> {
  const startedAt = new Date().toISOString();
  const recordingId = newId(`noise-fixture-${file.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
  const visitId = `visit-${recordingId}`;
  const durationContext = new AudioContext({ sampleRate: SAMPLE_RATE });
  const duration = (await durationContext.decodeAudioData(await file.arrayBuffer())).duration;
  await durationContext.close();

  await apiClient.createVisit({
    id: visitId,
    outletName: 'SYNTHETIC TEST · Noise suppression conversation 001',
    representativeId: 'synthetic-audio-evaluation',
    territoryId: 'synthetic-test-fixtures',
    consentRecordedAt: startedAt
  });
  await apiClient.createVisitRecording(visitId, {
    id: recordingId,
    startedAt,
    durationSeconds: duration,
    mimeType: file.type || 'audio/wav',
    byteLength: file.size,
    denoisedAnalysisAudio: {
      state: 'ready',
      mimeType: processed.type,
      byteLength: processed.size,
      sampleRateHz: SAMPLE_RATE,
      durationSeconds: duration,
      model: 'DeepFilterNet3',
      modelVersion: '@workadventure/noise-suppression@0.2.0'
    }
  });
  setState('uploading original');
  await apiClient.uploadRecordingAudio(recordingId, file);
  setState('uploading denoised audio');
  await apiClient.uploadRecordingAnalysisAudio(recordingId, processed);
  setState('queued for analysis');
  return recordingId;
}

export function NoiseFixtureRunner() {
  const [files, setFiles] = useState<File[]>([]);
  const [results, setResults] = useState<FixtureResult[]>([]);
  const [running, setRunning] = useState(false);
  const [health, setHealth] = useState<string>('Checking local API…');
  const [apiReady, setApiReady] = useState(false);
  const [pipelineAvailable, setPipelineAvailable] = useState(false);
  const stopRef = useRef(false);
  const safeApi = localHostnames.has(apiOrigin.hostname);

  useEffect(() => {
    if (!safeApi) {
      setHealth(`Blocked: fixture runs may only target a local API, not ${apiOrigin.hostname}.`);
      return;
    }
    void apiClient.getHealth().then((response) => {
      setHealth(`API ready · ${response.runtime.persistence} persistence · ${response.runtime.storageDriver} audio storage · analysis ${response.runtime.analysis}`);
      setApiReady(true);
      setPipelineAvailable(response.runtime.analysis === 'configured' && response.runtime.uploads === 'configured');
    }).catch((reason: unknown) => {
      setHealth(`API unavailable · ${reason instanceof Error ? reason.message : 'Could not read health status.'}`);
      setApiReady(false);
      setPipelineAvailable(false);
    });
  });

  async function runSelected() {
    if (running || !files.length || !safeApi || !apiReady || !pipelineAvailable) return;
    setRunning(true);
    stopRef.current = false;
    const ordered = [...files].sort((a, b) => fixtureOrder(a.name) - fixtureOrder(b.name));
    setResults(ordered.map((file) => ({ name: file.name, state: 'waiting', telemetry: [] })));

    for (const file of ordered) {
      if (stopRef.current) break;
      const pushTelemetry = (event: DeepFilterTelemetryEvent) => {
        const line = prettyTelemetry(event);
        setResults((current) => current.map((item) => item.name === file.name ? { ...item, telemetry: [...item.telemetry, line] } : item));
      };
      const setFixtureState = (state: FixtureState) => setResults((current) => current.map((item) => item.name === file.name ? { ...item, state } : item));
      try {
        setFixtureState('denoising');
        const processed = await denoiseFixture(file, pushTelemetry);
        if (stopRef.current) break;
        const recordingId = await uploadFixture(file, processed, setFixtureState);
        setResults((current) => current.map((item) => item.name === file.name ? { ...item, recordingId } : item));
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : 'Fixture processing failed.';
        setFixtureState('failed');
        setResults((current) => current.map((item) => item.name === file.name ? { ...item, detail: message } : item));
      }
    }
    setRunning(false);
  }

  return <main className="noise-fixture-page">
    <header className="noise-fixture-header">
      <h1>Noise suppression fixture runner</h1>
      <p>Developer-only test page. It sends synthetic fixtures through the field PWA’s DeepFilterNet service, then uploads the original and the processed sidecar to the local API.</p>
    </header>
    <aside className="noise-fixture-warning"><strong>Synthetic audio only.</strong> These files create test visits and analysis jobs in the configured local API database. Do not select real customer recordings.</aside>
    <p className="noise-fixture-health" role="status">{health}</p>
    <label className="noise-fixture-picker">Choose fixture WAV files
      <input type="file" accept="audio/wav,.wav" multiple disabled={running || !safeApi || !apiReady || !pipelineAvailable} onChange={(event) => setFiles(Array.from(event.currentTarget.files ?? []))}/>
    </label>
    <p className="noise-fixture-help">Select the clean reference and any noise variants from <code>test-fixtures/noise-suppression/conversation_001</code>. They run in clean, 80%, 100%, 125%, 150% order. Each takes roughly the recording’s duration because this is real-time Web Audio processing.</p>
    <div className="noise-fixture-actions">
      <button type="button" disabled={running || !files.length || !safeApi || !apiReady || !pipelineAvailable} onClick={() => void runSelected()}>{running ? 'Running fixtures…' : `Run ${files.length || 'selected'} fixture${files.length === 1 ? '' : 's'}`}</button>
      {running && <button className="noise-fixture-stop" type="button" onClick={() => { stopRef.current = true; }}>Stop after current stage</button>}
    </div>
    <ol className="noise-fixture-results" aria-live="polite">
      {results.map((result) => <li key={result.name}>
        <div className="noise-fixture-result-heading"><strong>{result.name}</strong><span>{result.state}</span></div>
        {result.detail && <p className="noise-fixture-error">{result.detail}</p>}
        {result.recordingId && <p>Recording ID: <code>{result.recordingId}</code></p>}
        {result.telemetry.length > 0 && <details><summary>DeepFilterNet telemetry</summary><ul>{result.telemetry.map((item, index) => <li key={`${result.name}-${index}`}>{item}</li>)}</ul></details>}
      </li>)}
    </ol>
  </main>;
}
