import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { ApexOptions } from 'apexcharts';
import { createApiClient, type ApiRuntimeHealth } from '@itc/api-client';
import {
  aggregateDemoSignals,
  demoConversations,
  demoDataNotice,
  type DemoConversation,
  type DemoSignalAggregate
} from '@itc/demo-data';
import { ReportChart } from '@itc/charts';
import type { AnalysisState, ManualTranscriptAnalysis, RecordingMetadata, RecordingTranscript, SyncState } from '@itc/domain';
import { OverviewPanel } from './overview-panel';
import { TranscriptImportForm, type TranscriptImportInput } from './transcript-import-form';
import '@fontsource-variable/hanken-grotesk';
import './styles.css';

type View = 'overview' | 'insights' | 'team' | 'visits';
type Period = '7' | '30' | 'all';
type CaptureApiState = 'loading' | 'available' | 'unavailable';
type TranscriptImportStatus = { kind: 'success' | 'error' | 'info'; message: string } | null;
type CaptureTranscriptState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; transcript: RecordingTranscript; refreshError?: string };

const captureApi = createApiClient({ baseUrl: '/api' });

const syncStateDetails: Record<SyncState, { label: string; detail: string }> = {
  queued: { label: 'queued', detail: 'Audio is waiting for S3 upload.' },
  uploading: { label: 'uploading', detail: 'Audio upload is in progress.' },
  uploaded: { label: 'uploaded', detail: 'Audio upload is complete.' },
  error: { label: 'error', detail: 'Audio upload failed.' }
};

const analysisStateDetails: Record<AnalysisState, { label: string; detail: string }> = {
  not_started: { label: 'Not started', detail: 'Transcript processing has not started.' },
  transcribing: { label: 'Transcribing', detail: 'The stored audio is being transcribed.' },
  analyzing: { label: 'Processing', detail: 'The stored audio is being processed.' },
  ready: { label: 'Transcript ready', detail: 'Transcript text is available from the uploaded recording.' },
  error: { label: 'Transcription failed', detail: 'The audio is stored; transcription needs attention.' }
};

const palette = {
  ink: '#18211b',
  green: '#176647',
  bright: '#c7ed7a',
  amber: '#a65d17',
  muted: '#637168',
  line: '#dfe5dd',
  grid: '#e7ece5',
  white: '#ffffff'
};

const demoAsOfDate = demoConversations.reduce(
  (latest, conversation) => conversation.createdAt.slice(0, 10) > latest ? conversation.createdAt.slice(0, 10) : latest,
  '1970-01-01'
);

function shiftDateKey(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const baseChart: ApexOptions = {
  chart: {
    background: 'transparent',
    fontFamily: 'Hanken Grotesk Variable, Hanken Grotesk, sans-serif',
    toolbar: { show: false },
    animations: { enabled: false },
    parentHeightOffset: 0,
    foreColor: palette.muted
  },
  dataLabels: { enabled: false },
  grid: { borderColor: palette.grid, strokeDashArray: 3, padding: { left: 0, right: 10 } },
  legend: { fontSize: '11px', fontWeight: 500, markers: { size: 4, strokeWidth: 0 }, itemMargin: { horizontal: 10, vertical: 4 } },
  tooltip: { theme: 'light', style: { fontSize: '12px', fontFamily: 'Hanken Grotesk Variable, sans-serif' } },
  noData: { text: 'No conversations in this range', align: 'center', verticalAlign: 'middle', style: { color: palette.muted, fontSize: '13px' } }
};

function formatCount(value: number | null | undefined): string {
  return new Intl.NumberFormat('en-IN').format(value ?? 0);
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function formatDateOnly(value: string): string {
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`));
}

function formatDueLabel(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDateOnly(value) : formatDateTime(value);
}

function conversationDateKey(item: Pick<DemoConversation, 'createdAt' | 'conversationDate'>): string {
  return item.conversationDate ?? item.createdAt.slice(0, 10);
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function outcomeLabel(value: DemoConversation['outcome']): string {
  if (value === 'order_placed') return 'Order placed';
  if (value === 'follow_up') return 'Follow-up';
  if (value === 'new_outlet') return 'New outlet';
  if (value === 'not_stated') return 'Not stated';
  return 'No order';
}

function categoryLabel(value: DemoSignalAggregate['category']): string {
  const labels: Record<DemoSignalAggregate['category'], string> = {
    demand: 'Demand',
    objection: 'Objection',
    availability: 'Availability',
    competitor: 'Competitor',
    sentiment: 'Sentiment',
    commitment: 'Commitment',
    conversation_quality: 'Coaching evidence'
  };
  return labels[value];
}

function minutes(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function Icon({ name }: { name: 'grid' | 'signal' | 'team' | 'list' | 'search' | 'download' | 'print' | 'arrow' | 'close' | 'play' }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  if (name === 'grid') return <svg viewBox="0 0 24 24" aria-hidden="true" {...common}><rect x="3.5" y="3.5" width="7" height="7" rx="1"/><rect x="13.5" y="3.5" width="7" height="7" rx="1"/><rect x="3.5" y="13.5" width="7" height="7" rx="1"/><rect x="13.5" y="13.5" width="7" height="7" rx="1"/></svg>;
  if (name === 'signal') return <svg viewBox="0 0 24 24" aria-hidden="true" {...common}><path d="M4 18.5V12M10 18.5V6M16 18.5v-9M22 18.5H2"/></svg>;
  if (name === 'team') return <svg viewBox="0 0 24 24" aria-hidden="true" {...common}><circle cx="9" cy="8" r="3"/><path d="M3.5 19c.4-3 2.4-4.5 5.5-4.5s5.1 1.5 5.5 4.5M17 8a2.5 2.5 0 1 1 0 5M17 15c2.2.2 3.5 1.5 3.8 4"/></svg>;
  if (name === 'list') return <svg viewBox="0 0 24 24" aria-hidden="true" {...common}><path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r=".7"/><circle cx="4" cy="12" r=".7"/><circle cx="4" cy="18" r=".7"/></svg>;
  if (name === 'search') return <svg viewBox="0 0 24 24" aria-hidden="true" {...common}><circle cx="10.8" cy="10.8" r="6.4"/><path d="m16 16 4.3 4.3"/></svg>;
  if (name === 'download') return <svg viewBox="0 0 24 24" aria-hidden="true" {...common}><path d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5M4 20h16"/></svg>;
  if (name === 'print') return <svg viewBox="0 0 24 24" aria-hidden="true" {...common}><path d="M7 8V4h10v4M7 17H5a2 2 0 0 1-2-2v-4a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v4a2 2 0 0 1-2 2h-2M7 14h10v6H7z"/><path d="M17 11h.01"/></svg>;
  if (name === 'arrow') return <svg viewBox="0 0 24 24" aria-hidden="true" {...common}><path d="M5 12h13m-5-5 5 5-5 5"/></svg>;
  if (name === 'close') return <svg viewBox="0 0 24 24" aria-hidden="true" {...common}><path d="m6 6 12 12M18 6 6 18"/></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true" {...common}><path d="m8 5 11 7-11 7z"/></svg>;
}

type AdminIdentity = { id: string; email: string; displayName: string };
type AuthPanel = 'loading' | 'setup' | 'login' | 'service-error';

function ManagerApp() {
  const [admin, setAdmin] = useState<AdminIdentity | null>(null);
  const [authPanel, setAuthPanel] = useState<AuthPanel>('loading');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  const loadAuthState = useCallback(async () => {
    setAuthError(null);
    setAuthPanel('loading');
    try {
      const status = await captureApi.getAdminAuthStatus();
      if (!status.adminExists) {
        setAuthPanel('setup');
        return;
      }
      try {
        setAdmin(await captureApi.getAdminSession());
        setAuthPanel('login');
      } catch (error) {
        if (error instanceof Error && 'status' in error && error.status === 401) {
          setAdmin(null);
          setAuthPanel('login');
          return;
        }
        throw error;
      }
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'The account service could not be reached.');
      setAuthPanel('service-error');
    }
  }, []);

  useEffect(() => { void loadAuthState(); }, [loadAuthState]);

  const finishAuth = useCallback((identity: AdminIdentity) => {
    setAdmin(identity);
    setAuthPanel('login');
    setAuthError(null);
  }, []);

  const handleLogin = useCallback(async (input: { email: string; password: string }) => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      finishAuth(await captureApi.loginAdmin(input));
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Sign in could not be completed.');
    } finally {
      setAuthBusy(false);
    }
  }, [finishAuth]);

  const handleBootstrap = useCallback(async (input: { email: string; password: string; displayName: string }) => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      finishAuth(await captureApi.bootstrapAdmin(input));
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Administrator setup could not be completed.');
    } finally {
      setAuthBusy(false);
    }
  }, [finishAuth]);

  const handleLogout = useCallback(async () => {
    setAuthBusy(true);
    try {
      await captureApi.logoutAdmin();
      setAdmin(null);
      setAuthPanel('login');
      setAuthError(null);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Sign out could not be completed.');
    } finally {
      setAuthBusy(false);
    }
  }, []);

  if (authPanel === 'loading') return <AuthLoading/>;
  if (authPanel === 'service-error') {
    return <AccountAccessPage mode="unavailable" busy={authBusy} error={authError} onRetry={() => { void loadAuthState(); }}/>;
  }
  if (admin) return <ManagerDashboard admin={admin} onLogout={() => { void handleLogout(); }} logoutBusy={authBusy} logoutError={authError}/>;
  if (authPanel === 'setup') {
    return <AccountAccessPage mode="setup" busy={authBusy} error={authError} onSubmitSetup={(input) => { void handleBootstrap(input); }}/>;
  }
  return <AccountAccessPage mode="login" busy={authBusy} error={authError} onSubmitLogin={(input) => { void handleLogin(input); }} onRetry={() => { void loadAuthState(); }}/>;
}

function AuthLoading() {
  return <main className="auth-shell" aria-busy="true" aria-live="polite">
    <section className="auth-panel auth-loading">
      <div className="auth-brand"><span className="brand-mark">FS</span><span><strong>Field Source</strong><small>MANAGER WORKSPACE</small></span></div>
      <p>Checking administrator access…</p>
    </section>
  </main>;
}

function AccountAccessPage({
  mode,
  busy,
  error,
  onSubmitSetup,
  onSubmitLogin,
  onRetry
}: {
  mode: 'setup' | 'login' | 'unavailable';
  busy: boolean;
  error: string | null;
  onSubmitSetup?: (input: { email: string; password: string; displayName: string }) => void;
  onSubmitLogin?: (input: { email: string; password: string }) => void;
  onRetry?: () => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const pageTitle = mode === 'setup' ? 'Create the administrator account'
    : mode === 'login' ? 'Sign in to Field Source' : 'Administrator access is unavailable';

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === 'setup') onSubmitSetup?.({ email, password, displayName });
    if (mode === 'login') onSubmitLogin?.({ email, password });
  }

  return <main className="auth-shell">
    <section className="auth-panel" aria-labelledby="auth-title">
      <div className="auth-brand"><span className="brand-mark">FS</span><span><strong>Field Source</strong><small>MANAGER WORKSPACE</small></span></div>
      <div className="auth-copy">
        <h1 id="auth-title">{pageTitle}</h1>
        <p>{mode === 'setup'
          ? 'Create the single administrator account that controls this reporting workspace.'
          : mode === 'login'
            ? 'Use your administrator credentials to review field recordings and transcripts.'
            : 'The API could not confirm account status. Check the service connection and try again.'}</p>
      </div>

      {mode === 'unavailable' ? <div className="auth-unavailable">
        {error && <p className="auth-error" role="alert">{error}</p>}
        <p>Retry after confirming the API is running.</p>
        <button className="auth-submit" type="button" onClick={onRetry} disabled={busy}>{busy ? 'Checking…' : 'Retry connection'}</button>
      </div> : <form className="auth-form" onSubmit={submit}>
        {mode === 'setup' && <>
          <label htmlFor="admin-display-name">Name</label>
          <input id="admin-display-name" name="displayName" autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required maxLength={100}/>
        </>}
        <label htmlFor="admin-email">Email</label>
        <input id="admin-email" name="email" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={254}/>
        <label htmlFor="admin-password">Password</label>
        <input id="admin-password" name="password" type="password" autoComplete={mode === 'setup' ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={12} maxLength={128}/>
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button className="auth-submit" type="submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'setup' ? 'Create administrator account' : 'Sign in'}</button>
        {mode === 'setup' && <p className="auth-privacy">This form is available until the first administrator account is created.</p>}
        {mode === 'login' && onRetry && <button className="auth-text-button" type="button" onClick={onRetry}>Refresh account status</button>}
      </form>}
    </section>
    <aside className="auth-aside" aria-label="Field Source Manager information">
      <div className="auth-aside-mark" aria-hidden="true">FS</div>
      <div><p>Conversation evidence, in context.</p><span>Review real recordings and transcripts alongside clearly labeled synthetic demo reports.</span></div>
      <small>Private administrator workspace</small>
    </aside>
  </main>;
}

function ManagerDashboard({ admin, onLogout, logoutBusy, logoutError }: { admin: AdminIdentity; onLogout: () => void; logoutBusy: boolean; logoutError: string | null }) {
  const [view, setView] = useState<View>('overview');
  const [period, setPeriod] = useState<Period>('7');
  const [territory, setTerritory] = useState('all');
  const [representative, setRepresentative] = useState('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [visitId, setVisitId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [fieldCaptures, setFieldCaptures] = useState<RecordingMetadata[]>([]);
  const [fieldCaptureTotal, setFieldCaptureTotal] = useState(0);
  const [captureApiState, setCaptureApiState] = useState<CaptureApiState>('loading');
  const [captureRuntime, setCaptureRuntime] = useState<ApiRuntimeHealth | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [captureLastUpdated, setCaptureLastUpdated] = useState<Date | null>(null);
  const [captureRefreshing, setCaptureRefreshing] = useState(false);
  const [activeCaptureAudio, setActiveCaptureAudio] = useState<{ id: string; url: string } | null>(null);
  const [captureAudioLoading, setCaptureAudioLoading] = useState<string | null>(null);
  const [capturePlaybackError, setCapturePlaybackError] = useState<string | null>(null);
  const [captureTranscriptStates, setCaptureTranscriptStates] = useState<Record<string, CaptureTranscriptState>>({});
  const [selectedCaptureTranscriptId, setSelectedCaptureTranscriptId] = useState<string | null>(null);
  const [captureTranscriptRetrying, setCaptureTranscriptRetrying] = useState<string | null>(null);
  const [manualTranscripts, setManualTranscripts] = useState<ManualTranscriptAnalysis[]>([]);
  const [transcriptApiState, setTranscriptApiState] = useState<CaptureApiState>('loading');
  const [transcriptImportBusy, setTranscriptImportBusy] = useState(false);
  const [transcriptImportStatus, setTranscriptImportStatus] = useState<TranscriptImportStatus>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const dialogCloseRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const captureRequestInFlightRef = useRef(false);

  const refreshFieldCaptures = useCallback(async () => {
    if (captureRequestInFlightRef.current) return;
    captureRequestInFlightRef.current = true;
    setCaptureRefreshing(true);
    try {
      const [health, page, transcriptPage] = await Promise.all([
        captureApi.getHealth(),
        captureApi.listRecordings({ limit: 100 }),
        captureApi.listTranscripts()
      ]);
      setFieldCaptures(page.recordings);
      setFieldCaptureTotal(page.total);
      setCaptureRuntime(health.runtime);
      setCaptureApiState('available');
      setManualTranscripts(transcriptPage.transcripts);
      setTranscriptApiState('available');
      setCaptureError(null);
      setCaptureLastUpdated(new Date());
    } catch (error) {
      setCaptureApiState('unavailable');
      setTranscriptApiState('unavailable');
      setCaptureError(error instanceof Error ? error.message : 'The capture API could not be reached.');
    } finally {
      captureRequestInFlightRef.current = false;
      setCaptureRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refreshFieldCaptures();
    const timer = window.setInterval(() => void refreshFieldCaptures(), 30_000);
    return () => window.clearInterval(timer);
  }, [refreshFieldCaptures]);

  const loadCaptureTranscript = useCallback(async (recordingId: string) => {
    setCaptureTranscriptStates((current) => current[recordingId]?.kind === 'loaded'
      ? current
      : { ...current, [recordingId]: { kind: 'loading' } });
    try {
      const transcript = await captureApi.getRecordingTranscript(recordingId);
      setCaptureTranscriptStates((current) => ({ ...current, [recordingId]: { kind: 'loaded', transcript } }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The transcript could not be loaded.';
      setCaptureTranscriptStates((current) => {
        const existing = current[recordingId];
        return {
          ...current,
          [recordingId]: existing?.kind === 'loaded'
            ? { ...existing, refreshError: message }
            : { kind: 'error', message }
        };
      });
    }
  }, []);

  useEffect(() => {
    if (!selectedCaptureTranscriptId) return;
    const current = captureTranscriptStates[selectedCaptureTranscriptId];
    if (current?.kind !== 'loaded' || !['queued', 'processing'].includes(current.transcript.state)) return;
    const timer = window.setInterval(() => void loadCaptureTranscript(selectedCaptureTranscriptId), 3_500);
    return () => window.clearInterval(timer);
  }, [captureTranscriptStates, loadCaptureTranscript, selectedCaptureTranscriptId]);

  const territories = useMemo(() => [...new Set([
    ...demoConversations.map((item) => item.territoryName ?? item.territoryId),
    ...manualTranscripts.map((item) => item.territoryName ?? item.territoryId),
    ...fieldCaptures.map((item) => item.territoryId)
  ])].sort(), [fieldCaptures, manualTranscripts]);
  const representatives = useMemo(() => [...new Set([
    ...demoConversations.map((item) => item.representativeName ?? item.representativeId),
    ...manualTranscripts.map((item) => item.representativeName ?? item.representativeId),
    ...fieldCaptures.map((item) => item.representativeId)
  ])].sort(), [fieldCaptures, manualTranscripts]);
  const reportAsOfDate = [new Date().toISOString().slice(0, 10), demoAsOfDate].sort().at(-1)!;
  const filteredFieldCaptures = useMemo(() => {
    const cutoff = period === 'all' ? 0 : Date.now() - Number(period) * 86_400_000;
    const query = search.trim().toLowerCase();
    return fieldCaptures.filter((item) => {
      if (Date.parse(item.startedAt) < cutoff) return false;
      if (territory !== 'all' && item.territoryId !== territory) return false;
      if (representative !== 'all' && item.representativeId !== representative) return false;
      if (query && !`${item.outletName} ${item.representativeId} ${item.territoryId} ${item.id}`.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [fieldCaptures, period, territory, representative, search]);
  const conversations = useMemo(() => {
    const cutoffDate = period === 'all' ? '0000-01-01' : shiftDateKey(reportAsOfDate, 1 - Number(period));
    const query = search.trim().toLowerCase();
    const manualReports: DemoConversation[] = manualTranscripts.map((item) => ({
      ...item,
      representativeName: item.representativeName ?? item.representativeId,
      representativeInitials: item.representativeInitials ?? item.representativeId.slice(0, 2).toUpperCase(),
      territoryName: item.territoryName ?? item.territoryId,
      outletId: item.outletId ?? `manual-outlet:${item.outletName.trim().toLocaleLowerCase()}`
    }));
    return [...demoConversations, ...manualReports].filter((item) => {
      const captureDate = conversationDateKey(item);
      if (captureDate > reportAsOfDate || captureDate < cutoffDate) return false;
      if (territory !== 'all' && (item.territoryName ?? item.territoryId) !== territory) return false;
      if (representative !== 'all' && (item.representativeName ?? item.representativeId) !== representative) return false;
      if (query && !`${item.outletName} ${item.representativeName ?? item.representativeId} ${item.territoryName ?? item.territoryId} ${item.summary}`.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [period, territory, representative, search, manualTranscripts, reportAsOfDate]);
  const signals = useMemo(() => aggregateDemoSignals(conversations), [conversations]);
  const visibleSignals = useMemo(() => signals.filter((item) => item.category !== 'conversation_quality'), [signals]);
  const selectedSignal = visibleSignals.find((item) => item.taxonomyKey === selectedKey) ?? visibleSignals[0];
  const selectedEvidence = selectedSignal?.examples[0];
  const evidenceVisit = selectedEvidence ? conversations.find((item) => item.id === selectedEvidence.visitId) : undefined;
  const detailVisit = conversations.find((item) => item.id === visitId);
  const originalTranscriptText = detailVisit?.source === 'manual_transcript'
    ? manualTranscripts.find((item) => item.id === detailVisit.id)?.rawTranscript
    : undefined;
  useEffect(() => {
    if (!detailVisit) return;
    dialogCloseRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setVisitId(null);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])');
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus();
    };
  }, [detailVisit]);
  const analyzedCount = conversations.length;
  const outletCount = new Set(conversations.map((item) => item.outletId ?? item.outletName.trim().toLocaleLowerCase())).size;
  const orderCount = conversations.filter((item) => item.outcome === 'order_placed').length;
  const followUpCount = conversations.filter((item) => item.outcome === 'follow_up').length;
  const totalExplicitOrderValue = conversations.reduce((sum, item) => sum + (item.confirmedOrderValueInr ?? 0), 0);
  const territoryRows = selectedSignal ? conversations.reduce<Array<{ name: string; mentions: number; outlets: Set<string> }>>((rows, conversation) => {
    const matching = conversation.insights.filter((insight) => insight.taxonomyKey === selectedSignal.taxonomyKey);
    if (!matching.length) return rows;
    const territoryName = conversation.territoryName ?? conversation.territoryId;
    let row = rows.find((item) => item.name === territoryName);
    if (!row) { row = { name: territoryName, mentions: 0, outlets: new Set<string>() }; rows.push(row); }
    row.mentions += matching.reduce((sum, insight) => sum + insight.mentionCount, 0);
    row.outlets.add(conversation.outletId ?? conversation.outletName.trim().toLocaleLowerCase());
    return rows;
  }, []).sort((a, b) => b.mentions - a.mentions) : [];
  const maxMentions = Math.max(1, ...territoryRows.map((row) => row.mentions));
  const orderValues = conversations.filter((item) => item.confirmedOrderValueInr !== undefined);

  const categoryRows = useMemo(() => {
    return signals
      .filter((item) => item.category !== 'conversation_quality')
      .map((signal) => ({ ...signal, share: analyzedCount ? signal.distinctVisitCount / analyzedCount : 0 }))
      .sort((a, b) => b.distinctVisitCount - a.distinctVisitCount || b.rawMentionCount - a.rawMentionCount)
      .slice(0, 7);
  }, [signals, analyzedCount]);

  const trendBuckets = useMemo(() => {
    const buckets = new Map<string, { label: string; timestamp: number; visits: number; orders: number; followUps: number }>();
    for (const item of conversations) {
      const date = new Date(`${conversationDateKey(item)}T12:00:00`);
      const label = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' }).format(date);
      const existing = buckets.get(label) ?? { label, timestamp: new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(), visits: 0, orders: 0, followUps: 0 };
      existing.visits += 1;
      existing.orders += Number(item.outcome === 'order_placed');
      existing.followUps += Number(item.outcome === 'follow_up');
      buckets.set(label, existing);
    }
    return [...buckets.values()].sort((a, b) => a.timestamp - b.timestamp);
  }, [conversations]);

  const outcomeRows = useMemo(() => [
    { label: 'Order placed', count: conversations.filter((item) => item.outcome === 'order_placed').length, color: palette.green },
    { label: 'Follow-up agreed', count: conversations.filter((item) => item.outcome === 'follow_up').length, color: '#b2c96b' },
    { label: 'No order', count: conversations.filter((item) => item.outcome === 'no_order').length, color: '#c78343' },
    { label: 'New outlet', count: conversations.filter((item) => item.outcome === 'new_outlet').length, color: '#5e8270' },
    { label: 'Not stated', count: conversations.filter((item) => item.outcome === 'not_stated').length, color: '#87938b' }
  ], [conversations]);

  const sentimentRows = useMemo(() => {
    const labels = ['positive', 'neutral', 'hesitant', 'at_risk', 'unknown'] as const;
    return labels.map((label) => ({ label: label.replace('_', ' '), count: conversations.filter((item) => item.sentimentCue === label).length }));
  }, [conversations]);

  const demandSignals = signals.filter((signal) => signal.category === 'demand').slice(0, 5);
  const demandHeatmapSeries = [...new Set(conversations.map((item) => item.territoryName ?? item.territoryId))].sort().map((territoryName) => ({
    name: territoryName,
    data: demandSignals.map((signal) => ({
      x: signal.title,
      y: conversations.filter((conversation) => (conversation.territoryName ?? conversation.territoryId) === territoryName && conversation.insights.some((insight) => insight.taxonomyKey === signal.taxonomyKey)).length
    }))
  }));

  const objectionRows = signals
    .filter((signal) => signal.category === 'objection' || signal.category === 'competitor')
    .map((signal) => ({ ...signal, share: analyzedCount ? signal.distinctVisitCount / analyzedCount : 0 }))
    .sort((a, b) => b.distinctVisitCount - a.distinctVisitCount || b.rawMentionCount - a.rawMentionCount);

  const coachingRows = (['discovery', 'benefit_explanation', 'objection_response', 'close_or_next_step'] as const).map((rubricKey) => {
    const supported = conversations.flatMap((conversation) => conversation.coachingSignals
      .filter((signal) => signal.rubricKey === rubricKey)
      .map((signal) => ({ conversation, signal })));
    const labels = {
      discovery: 'Discovery questions',
      benefit_explanation: 'Benefit explanation',
      objection_response: 'Objection response',
      close_or_next_step: 'Close or next step'
    };
    return {
      rubricKey,
      label: labels[rubricKey],
      distinctVisitCount: new Set(supported.map((item) => item.conversation.id)).size,
      evidenceCount: supported.length,
      examples: supported.slice(0, 2).map(({ conversation, signal }) => ({
        visitId: conversation.id,
        outletName: conversation.outletName,
        note: signal.note,
        confidence: signal.confidence
      }))
    };
  });

  const followUpTimingRows = useMemo(() => {
    const buckets = [
      { label: 'Overdue', count: 0 },
      { label: 'Due today', count: 0 },
      { label: 'Next 7 days', count: 0 },
      { label: 'Later', count: 0 },
      { label: 'No date stated', count: 0 }
    ];
    for (const conversation of conversations.filter((item) => item.outcome === 'follow_up')) {
      if (!conversation.nextActionDue) {
        buckets[4].count += 1;
        continue;
      }
      const dueDate = conversation.nextActionDue.slice(0, 10);
      const dayOffset = Math.round((Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${reportAsOfDate}T00:00:00Z`)) / 86_400_000);
      if (dayOffset < 0) buckets[0].count += 1;
      else if (dayOffset === 0) buckets[1].count += 1;
      else if (dayOffset <= 7) buckets[2].count += 1;
      else buckets[3].count += 1;
    }
    return buckets;
  }, [conversations, reportAsOfDate]);

  const representativeRows = useMemo(() => representatives
    .filter((name) => representative === 'all' || name === representative)
    .map((name) => {
      const visits = conversations.filter((item) => (item.representativeName ?? item.representativeId) === name);
      return {
        name,
        initials: visits[0]?.representativeInitials ?? name.split(' ').map((part) => part[0]).join('').slice(0, 2),
        visits: visits.length,
        orders: visits.filter((item) => item.outcome === 'order_placed').length,
        followUps: visits.filter((item) => item.outcome === 'follow_up').length,
        evidence: visits.reduce((sum, item) => sum + item.insights.filter((insight) => insight.evidence.length > 0).length, 0)
      }
    }).sort((a, b) => b.visits - a.visits || a.name.localeCompare(b.name)), [conversations, representatives, representative]);

  const selectSignal = (key: string) => setSelectedKey(key);
  const openVisit = (id?: string) => {
    if (!id) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setVisitId(id);
  };

  const commonAxis = {
    labels: { style: { colors: palette.muted, fontSize: '11px', fontFamily: 'Hanken Grotesk Variable, sans-serif' } },
    axisBorder: { show: false },
    axisTicks: { show: false }
  };

  const categoryOptions: ApexOptions = {
    ...baseChart,
    chart: { ...baseChart.chart, type: 'bar' },
    colors: [palette.green],
    plotOptions: { bar: { horizontal: true, barHeight: '57%', borderRadius: 2, distributed: false } },
    xaxis: { ...commonAxis, categories: categoryRows.map((row) => row.title), tickAmount: 4, title: { text: 'Distinct visits', style: { fontSize: '10px', fontWeight: 500 } } },
    yaxis: { labels: { maxWidth: 220, style: { colors: palette.ink, fontSize: '11px', fontFamily: 'Hanken Grotesk Variable, sans-serif' } } },
    tooltip: { ...baseChart.tooltip, y: { formatter: (value) => `${formatCount(value)} distinct visits` } }
  };

  const outcomeOptions: ApexOptions = {
    ...baseChart,
    chart: { ...baseChart.chart, type: 'donut' },
    labels: outcomeRows.map((item) => item.label),
    colors: outcomeRows.map((item) => item.color),
    stroke: { width: 2, colors: [palette.white] },
    dataLabels: { enabled: false },
    legend: { ...baseChart.legend, position: 'bottom' },
    plotOptions: { pie: { donut: { size: '70%' } } },
    tooltip: { ...baseChart.tooltip, y: { formatter: (value) => `${formatCount(value)} visits` } }
  };

  const trendOptions: ApexOptions = {
    ...baseChart,
    chart: { ...baseChart.chart, type: 'area', stacked: true },
    colors: [palette.green, '#a7c666', '#dfa45f'],
    stroke: { curve: 'smooth', width: 2 },
    fill: { type: 'solid', opacity: [0.15, 0.25, 0.2] },
    xaxis: { ...commonAxis, categories: trendBuckets.map((item) => item.label) },
    yaxis: { min: 0, forceNiceScale: true, labels: { style: { colors: palette.muted, fontSize: '11px' } }, title: { text: 'Visits', style: { fontSize: '10px', fontWeight: 500 } } },
    legend: { ...baseChart.legend, position: 'top', horizontalAlign: 'right' },
    tooltip: { ...baseChart.tooltip, shared: true, intersect: false, y: { formatter: (value) => `${formatCount(value)} visits` } }
  };

  const sentimentOptions: ApexOptions = {
    ...baseChart,
    chart: { ...baseChart.chart, type: 'bar', stacked: true },
    colors: [palette.green, '#829889', '#d2a45e', '#b16a44', '#b7c0ba'],
    plotOptions: { bar: { horizontal: false, columnWidth: '42%', borderRadius: 2 } },
    xaxis: { ...commonAxis, categories: ['Conversation cues'] },
    yaxis: { min: 0, forceNiceScale: true, labels: { style: { colors: palette.muted, fontSize: '11px' } }, title: { text: 'Visits', style: { fontSize: '10px', fontWeight: 500 } } },
    legend: { ...baseChart.legend, position: 'bottom' },
    tooltip: { ...baseChart.tooltip, y: { formatter: (value) => `${formatCount(value)} visits` } }
  };

  const demandHeatmapOptions: ApexOptions = {
    ...baseChart,
    chart: { ...baseChart.chart, type: 'heatmap' },
    dataLabels: { enabled: true, style: { colors: [palette.ink], fontSize: '10px', fontWeight: 600 } },
    plotOptions: { heatmap: { enableShades: true, shadeIntensity: 0.35, radius: 2, useFillColorAsStroke: false, colorScale: { ranges: [
      { from: 0, to: 0, name: 'No visits', color: '#edf1ea' },
      { from: 1, to: 2, name: '1–2 visits', color: '#d2e2cf' },
      { from: 3, to: 5, name: '3–5 visits', color: '#91b794' },
      { from: 6, to: 100, name: '6+ visits', color: palette.green }
    ] } } },
    xaxis: { ...commonAxis, type: 'category' },
    yaxis: { labels: { style: { colors: palette.ink, fontSize: '10px', fontFamily: 'Hanken Grotesk Variable, sans-serif' } } },
    legend: { ...baseChart.legend, position: 'bottom' },
    tooltip: { ...baseChart.tooltip, y: { formatter: (value) => `${formatCount(value)} distinct visits` } }
  };

  const objectionOptions: ApexOptions = {
    ...baseChart,
    chart: { ...baseChart.chart, type: 'bar' },
    colors: ['#b67c37'],
    plotOptions: { bar: { horizontal: true, barHeight: '55%', borderRadius: 2 } },
    xaxis: { ...commonAxis, categories: objectionRows.map((row) => row.title), tickAmount: 4, title: { text: 'Distinct visits', style: { fontSize: '10px', fontWeight: 500 } } },
    yaxis: { labels: { maxWidth: 220, style: { colors: palette.ink, fontSize: '10px', fontFamily: 'Hanken Grotesk Variable, sans-serif' } } },
    tooltip: { ...baseChart.tooltip, y: { formatter: (value) => `${formatCount(value)} distinct visits` } }
  };

  const coachingOptions: ApexOptions = {
    ...baseChart,
    chart: { ...baseChart.chart, type: 'bar' },
    colors: [palette.green],
    plotOptions: { bar: { horizontal: true, barHeight: '48%', borderRadius: 2 } },
    xaxis: { ...commonAxis, categories: coachingRows.map((row) => row.label), tickAmount: 4, title: { text: 'Visits with cited evidence', style: { fontSize: '10px', fontWeight: 500 } } },
    yaxis: { labels: { maxWidth: 180, style: { colors: palette.ink, fontSize: '10px', fontFamily: 'Hanken Grotesk Variable, sans-serif' } } },
    tooltip: { ...baseChart.tooltip, y: { formatter: (value) => `${formatCount(value)} visits with evidence` } }
  };

  const followUpTimingOptions: ApexOptions = {
    ...baseChart,
    chart: { ...baseChart.chart, type: 'bar' },
    colors: ['#bc8439'],
    plotOptions: { bar: { horizontal: false, columnWidth: '45%', borderRadius: 2 } },
    xaxis: { ...commonAxis, categories: followUpTimingRows.map((row) => row.label), labels: { ...commonAxis.labels, rotate: -20, trim: true } },
    yaxis: { min: 0, forceNiceScale: true, labels: { style: { colors: palette.muted, fontSize: '11px' } }, title: { text: 'Agreed follow-ups', style: { fontSize: '10px', fontWeight: 500 } } },
    tooltip: { ...baseChart.tooltip, y: { formatter: (value) => `${formatCount(value)} follow-ups` } }
  };

  const viewTitle: Record<View, string> = {
    overview: 'Field activity at a glance',
    insights: selectedSignal?.taxonomyKey === 'demand.small-pack-five-rupees' ? 'Retailers are asking for smaller packs' : selectedSignal?.title ?? 'Conversation signals',
    team: 'Field activity with its evidence attached',
    visits: 'Recent field conversations'
  };

  function openSelectedEvidence() {
    if (evidenceVisit) openVisit(evidenceVisit.id);
  }

  async function toggleCaptureAudio(recordingId: string) {
    if (activeCaptureAudio?.id === recordingId) {
      setActiveCaptureAudio(null);
      return;
    }
    setCaptureAudioLoading(recordingId);
    setCapturePlaybackError(null);
    try {
      const link = await captureApi.getRecordingDownloadUrl(recordingId);
      setActiveCaptureAudio({ id: recordingId, url: link.url });
    } catch (error) {
      setCapturePlaybackError(error instanceof Error ? error.message : 'The uploaded audio link could not be created.');
    } finally {
      setCaptureAudioLoading(null);
    }
  }

  function toggleCaptureTranscript(recordingId: string) {
    if (selectedCaptureTranscriptId === recordingId) {
      setSelectedCaptureTranscriptId(null);
      return;
    }
    setSelectedCaptureTranscriptId(recordingId);
    const transcriptState = captureTranscriptStates[recordingId];
    if (transcriptState?.kind !== 'loaded') void loadCaptureTranscript(recordingId);
  }

  async function retryCaptureTranscript(recordingId: string) {
    setCaptureTranscriptRetrying(recordingId);
    setCaptureTranscriptStates((current) => ({ ...current, [recordingId]: { kind: 'loading' } }));
    try {
      const transcript = await captureApi.retryRecordingTranscription(recordingId);
      setCaptureTranscriptStates((current) => ({ ...current, [recordingId]: { kind: 'loaded', transcript } }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The transcription could not be retried.';
      setCaptureTranscriptStates((current) => ({ ...current, [recordingId]: { kind: 'error', message } }));
    } finally {
      setCaptureTranscriptRetrying(null);
    }
  }

  function hasCompletedCaptureTranscript(recordingId: string): boolean {
    const transcriptState = captureTranscriptStates[recordingId];
    return transcriptState?.kind === 'loaded' && transcriptState.transcript.state === 'completed';
  }

  function renderCaptureTranscript(recordingId: string) {
    if (selectedCaptureTranscriptId !== recordingId) return null;
    const transcriptState = captureTranscriptStates[recordingId];
    return <section className="capture-transcript-panel" aria-label="Recording transcript" aria-live="polite">
      <div className="capture-transcript-heading"><h3>Transcript from this recording</h3><span>Real PWA audio · separate from synthetic reports</span></div>
      {!transcriptState && <p className="capture-transcript-loading" role="status">Requesting transcript status…</p>}
      {transcriptState?.kind === 'loading' && <div className="capture-transcript-loading" role="status"><i aria-hidden="true"/>Loading transcript status…</div>}
      {transcriptState?.kind === 'error' && <div className="capture-transcript-message" role="alert"><p>{transcriptState.message}</p><button className="transcript-action" type="button" onClick={() => void loadCaptureTranscript(recordingId)}>Try loading again</button></div>}
      {transcriptState?.kind === 'loaded' && (() => {
        const { transcript } = transcriptState;
        const stateLabel: Record<RecordingTranscript['state'], string> = {
          not_started: 'Not started',
          queued: 'Queued',
          processing: 'Transcribing',
          completed: 'Transcript ready',
          failed: 'Transcription failed'
        };
        return <>
          <div className="capture-transcript-status-row"><span className={`capture-transcript-status state-${transcript.state}`}>{stateLabel[transcript.state]}</span>{transcript.state === 'completed' && transcript.languageCodes?.length ? <span>Language: {transcript.languageCodes.join(', ')}</span> : null}</div>
          {transcript.state === 'queued' && <p className="capture-transcript-message" role="status">The stored audio is waiting in the transcription queue.</p>}
          {transcript.state === 'processing' && <p className="capture-transcript-message" role="status">The stored audio is being transcribed. This panel refreshes while processing continues.</p>}
          {transcript.state === 'not_started' && <p className="capture-transcript-message" role="status">Transcription has not started yet. Refresh this panel after the audio finishes uploading.</p>}
          {transcript.state === 'failed' && <div className="capture-transcript-message" role="alert"><p>{transcript.errorMessage ?? 'The recording could not be transcribed.'}</p>{transcript.retryable
            ? <button className="transcript-action" type="button" onClick={() => void retryCaptureTranscript(recordingId)} disabled={captureTranscriptRetrying === recordingId}>{captureTranscriptRetrying === recordingId ? 'Retrying…' : 'Retry transcription'}</button>
            : <small>Ask the API operator to check the transcription configuration or recording format.</small>}</div>}
          {transcript.state === 'completed' && transcript.transcriptText?.trim()
            ? <p className="capture-transcript-text">{transcript.transcriptText}</p>
            : transcript.state === 'completed' ? <p className="capture-transcript-message">No transcript text was returned for this recording.</p> : null}
          {transcript.state === 'completed' && <small className="capture-transcript-provenance">{transcript.provider} · {transcript.model} · transcript text only; no speaker turns or timings were supplied</small>}
          {transcriptState.refreshError && <p className="capture-transcript-refresh-error" role="status">Could not refresh transcription status: {transcriptState.refreshError}</p>}
        </>;
      })()}
    </section>;
  }

  async function ingestManualTranscript(input: TranscriptImportInput) {
    setTranscriptImportBusy(true);
    setTranscriptImportStatus(null);
    try {
      const result = await captureApi.ingestTranscript(input);
      setManualTranscripts((current) => [result, ...current.filter((item) => item.id !== result.id)]);
      setTranscriptApiState('available');
      setTranscriptImportStatus({
        kind: 'success',
        message: result.storageState === 's3'
          ? `Analysis is ready. The source transcript is stored in S3 at ${result.objectKey}.`
          : 'Analysis is ready for this API session. Configure S3 credentials to persist the source transcript.'
      });
      setView('insights');
    } catch (error) {
      setTranscriptApiState(error instanceof Error && 'status' in error && error.status === 0 ? 'unavailable' : transcriptApiState);
      setTranscriptImportStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'The transcript could not be analyzed. Check the API and try again.'
      });
    } finally {
      setTranscriptImportBusy(false);
    }
  }

  function renderLiveCapturePreview() {
    const recent = filteredFieldCaptures.slice(0, 4);
    return <section className="live-capture-preview" aria-labelledby="live-capture-title" aria-busy={captureRefreshing}>
      <div className="live-capture-heading"><div><h2 id="live-capture-title">Live field recordings</h2><p>Real PWA captures from the API. They are kept separate from transcript-derived conversation reports below.</p></div>
        <button className="text-action" type="button" onClick={() => setView('visits')}>Open capture history <Icon name="arrow"/></button>
      </div>
      {captureApiState === 'unavailable' && <p className="live-capture-empty">The capture API is unavailable. Start the API to see recordings made in the PWA.</p>}
      {captureApiState === 'loading' && !fieldCaptures.length && <p className="live-capture-empty">Checking for live PWA recordings…</p>}
      {captureApiState === 'available' && !recent.length && <p className="live-capture-empty">{fieldCaptures.length ? 'No real captures match the selected period, territory, representative, or search.' : 'No real recording has arrived yet. Record and upload one from the Field PWA to hear it here.'}</p>}
      {capturePlaybackError && <p className="live-capture-error" role="alert">{capturePlaybackError}</p>}
      {recent.map((recording) => <article className="live-capture-row" key={recording.id}>
        <div className="live-capture-identity"><strong>{recording.outletName}</strong><span>{recording.representativeId} · {recording.territoryId}</span></div>
        <div className="live-capture-meta"><time dateTime={recording.startedAt}>{formatDateTime(recording.startedAt)}</time><span>{formatDuration(Math.round(recording.durationSeconds))}</span><span>{syncStateDetails[recording.syncState].label}</span></div>
        {recording.syncState === 'uploaded'
          ? <div className="live-capture-actions"><span className={`capture-compact-status analysis-${recording.analysisState}`}>{analysisStateDetails[recording.analysisState].label}</span><button className="live-audio-button" type="button" onClick={() => void toggleCaptureAudio(recording.id)} disabled={captureAudioLoading === recording.id}>{captureAudioLoading === recording.id ? 'Loading…' : activeCaptureAudio?.id === recording.id ? 'Close audio' : 'Listen to audio'}</button><button className="live-transcript-button" type="button" aria-expanded={selectedCaptureTranscriptId === recording.id} aria-controls={`recording-transcript-${recording.id}`} onClick={() => toggleCaptureTranscript(recording.id)}>{selectedCaptureTranscriptId === recording.id ? 'Hide transcript' : hasCompletedCaptureTranscript(recording.id) ? 'View transcript' : 'Transcript status'}</button></div>
          : <span className={`live-upload-state sync-${recording.syncState}`}>{recording.syncState === 'queued' ? 'Waiting for upload' : recording.syncState === 'uploading' ? 'Uploading' : 'Upload needs attention'}</span>}
        {activeCaptureAudio?.id === recording.id && <audio className="live-capture-player" controls preload="none" src={activeCaptureAudio.url} aria-label={`Uploaded recording from ${recording.outletName}`}/>}
        <div id={`recording-transcript-${recording.id}`} className="live-transcript-slot" hidden={selectedCaptureTranscriptId !== recording.id}>{renderCaptureTranscript(recording.id)}</div>
      </article>)}
    </section>;
  }

  function renderFilters() {
    return <div className="report-filters" aria-label="Report filters">
      <label className="sr-only" htmlFor="period-filter">Reporting period</label>
      <select id="period-filter" value={period} onChange={(event) => setPeriod(event.target.value as Period)}>
        <option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="all">All dates</option>
      </select>
      <label className="sr-only" htmlFor="territory-filter">Territory</label>
      <select id="territory-filter" value={territory} onChange={(event) => setTerritory(event.target.value)}>
        <option value="all">All territories</option>{territories.map((item) => <option key={item} value={item}>{item}</option>)}
      </select>
      <label className="sr-only" htmlFor="rep-filter">Representative</label>
      <select id="rep-filter" value={representative} onChange={(event) => setRepresentative(event.target.value)}>
        <option value="all">All representatives</option>{representatives.map((item) => <option key={item} value={item}>{item}</option>)}
      </select>
    </div>;
  }

  function renderOverview() {
    return <OverviewPanel
      conversations={conversations}
      captures={filteredFieldCaptures}
      totalCaptureCount={fieldCaptureTotal}
      captureState={captureApiState}
      periodLabel={period === '7' ? 'Last 7 days' : period === '30' ? 'Last 30 days' : 'all dates'}
      onOpenInsights={() => setView('insights')}
      onOpenVisits={() => setView('visits')}
    />;
  }

  function renderTranscriptImport() {
    return <TranscriptImportForm
      busy={transcriptImportBusy}
      storageConfigured={captureRuntime?.uploads === 'configured'}
      status={transcriptImportStatus ?? (transcriptApiState === 'unavailable'
        ? { kind: 'error', message: 'The API is unavailable. Start or refresh the API connection, then retry the transcript.' }
        : null)}
      onIngest={ingestManualTranscript}
    />;
  }

  function renderInsights() {
    if (!conversations.length) return <>{renderTranscriptImport()}{renderLiveCapturePreview()}<div className="empty-state"><Icon name="search"/><h2>No analyzed conversations match these filters</h2><p>Import a consented transcript below or change the date range and filters to review the seeded demo reports.</p><button className="button" onClick={() => { setPeriod('all'); setTerritory('all'); setRepresentative('all'); setSearch(''); }}>Show all reports</button></div></>;
    return <>
      {renderTranscriptImport()}
      {renderLiveCapturePreview()}
      <div className="pulse-strip" aria-label="Field pulse">
        <div className="pulse-item"><span>Analyzed visits</span><strong>{formatCount(analyzedCount)}</strong><small>in selected period</small></div>
          <div className="pulse-item"><span>Unique outlets</span><strong>{formatCount(outletCount)}</strong><small>distinct shopkeepers</small></div>
        <div className="pulse-item"><span>Confirmed orders</span><strong>{formatCount(orderCount)}</strong><small>stated in conversation</small></div>
        <div className="pulse-item"><span>Follow-ups agreed</span><strong>{formatCount(followUpCount)}</strong><small>explicit next steps</small></div>
        <div className="pulse-item pulse-value"><span>Stated order value</span><strong>₹{formatCount(totalExplicitOrderValue)}</strong><small>{orderValues.length} value(s) explicitly stated</small></div>
      </div>

      <div className="insight-layout">
        <section className="signal-workspace" aria-label="Conversation signal report">
          <div className="section-heading"><div><h2>What is surfacing in conversations</h2><p>Distinct visits and mentions are counted separately.</p></div><span className="section-period">{period === '7' ? 'Last 7 days' : period === '30' ? 'Last 30 days' : 'All dates'}</span></div>
          {selectedSignal ? <>
            <div className="signal-header">
              <div><span className={`category-tag category-${selectedSignal.category}`}>{categoryLabel(selectedSignal.category)}</span><h3>{selectedSignal.title}</h3><p>{selectedSignal.rawMentionCount} supported mention{selectedSignal.rawMentionCount === 1 ? '' : 's'} from <strong>{selectedSignal.distinctOutletCount} unique outlet{selectedSignal.distinctOutletCount === 1 ? '' : 's'}</strong> across {selectedSignal.territories.length} territor{selectedSignal.territories.length === 1 ? 'y' : 'ies'}.</p></div>
              <span className="confidence-state"><i className={`confidence-dot confidence-${selectedSignal.confidenceCounts.high > 0 ? 'high' : selectedSignal.confidenceCounts.medium > 0 ? 'medium' : 'low'}`}/>{selectedSignal.confidenceCounts.high > 0 ? 'Evidence available' : 'Review evidence'}</span>
            </div>
            <div className="signal-detail">
              <div className="territory-spread">
                <div className="mini-heading"><h4>Where it appears</h4><span>mentions / outlets</span></div>
                {territoryRows.length ? territoryRows.map((row) => <div className="territory-row" key={row.name}><span className="territory-name">{row.name}</span><span className="territory-track"><i style={{ width: `${Math.max(8, row.mentions / maxMentions * 100)}%` }}/></span><strong>{row.mentions} / {row.outlets.size}</strong></div>) : <p className="muted">No territory detail in this range.</p>}
                <p className="denominator-note">A visit contributes once to outlet reach even when the retailer repeats a point.</p>
              </div>
              <div className="signal-profile">
                <div className="mini-heading"><h4>Signal profile</h4><span>source-aware</span></div>
                <div className="profile-row"><span>Signal type</span><strong>{categoryLabel(selectedSignal.category)}</strong></div>
                <div className="profile-row"><span>Confidence mix</span><strong>{selectedSignal.confidenceCounts.high} high · {selectedSignal.confidenceCounts.medium} medium · {selectedSignal.confidenceCounts.low} low</strong></div>
                <div className="profile-row"><span>Visit reach</span><strong>{selectedSignal.distinctVisitCount} of {analyzedCount}</strong></div>
                <div className="profile-row"><span>Order status</span><strong>Tracked separately</strong></div>
              </div>
            </div>
            <div className="signal-evidence">
              <div className="evidence-copy">
                <span className="evidence-label"><i/> Transcript evidence · shopkeeper</span>
                <blockquote>“{selectedEvidence?.quote ?? 'No transcript quote is attached to this signal yet.'}”</blockquote>
                {evidenceVisit && <div className="quote-source"><strong>{evidenceVisit.outletName}</strong><span>{evidenceVisit.territoryName}</span><span>{formatDateTime(evidenceVisit.createdAt)}</span><span className="confidence-note">{selectedEvidence?.confidence ?? 'unreviewed'} confidence</span></div>}
              </div>
              <button className="text-action" onClick={openSelectedEvidence} disabled={!evidenceVisit}>Open supporting visit <Icon name="arrow"/></button>
            </div>
          </> : <div className="empty-inline">No evidence-backed signals found for this range.</div>}
        </section>

        <aside className="evidence-rail" aria-label="Signal navigation and next action">
          <div className="signal-list-head"><div><h2>Signal register</h2><p>{visibleSignals.length} evidence-backed themes</p></div><span className="register-mark">{visibleSignals.length.toString().padStart(2, '0')}</span></div>
          <div className="signal-list">
            {visibleSignals.slice(0, 6).map((signal, index) => <button className={`signal-list-item ${selectedSignal?.taxonomyKey === signal.taxonomyKey ? 'is-selected' : ''}`} key={signal.taxonomyKey} onClick={() => selectSignal(signal.taxonomyKey)} aria-pressed={selectedSignal?.taxonomyKey === signal.taxonomyKey}>
              <span className="signal-rank">{String(index + 1).padStart(2, '0')}</span><span className="signal-list-copy"><strong>{signal.title}</strong><small>{categoryLabel(signal.category)} · {signal.distinctOutletCount} outlets</small></span><span className="signal-count">{signal.rawMentionCount}</span>
            </button>)}
          </div>
          {selectedSignal?.category === 'competitor' && selectedSignal.confidenceCounts.low > 0 && <div className="uncertainty-note"><strong>Unverified detail</strong><p>Keep brand, pack size, and price unresolved until a representative confirms them in the outlet.</p></div>}
          <div className="manager-action">
            <div className="action-topline"><span>Suggested next step</span><span className="action-dot"/></div>
            <h3>{selectedEvidence?.quote ? 'Bring this signal into the next route review' : 'Review the available evidence'}</h3>
            <p>Check the selected quote with the outlet context before changing assortment or sales commitments.</p>
            <button className="button action-button" onClick={openSelectedEvidence} disabled={!evidenceVisit}>Review supporting conversation <Icon name="arrow"/></button>
          </div>
        </aside>
      </div>

      <div className="reporting-heading"><div><h2>Read the field pattern</h2><p>Reach, outcome, timing, and coaching evidence from the filtered conversations.</p></div><span className="synthetic-badge">{conversations.some((item) => item.source === 'manual_transcript') ? 'SYNTHETIC + IMPORTED REPORTS' : 'SYNTHETIC DATA'}</span></div>
      <div className="chart-grid">
        <section className="chart-panel chart-wide"><div className="chart-heading"><div><h3>Conversation outcomes over time</h3><p>Seeded capture dates and manually supplied conversation dates; otherwise manual imports use their import date.</p></div><button className="icon-button" title="Open visit history" aria-label="Open visit history" onClick={() => setView('visits')}><Icon name="arrow"/></button></div>
          <ReportChart type="area" height={260} options={trendOptions} series={[{ name: 'Visits', data: trendBuckets.map((item) => item.visits) }, { name: 'Order placed', data: trendBuckets.map((item) => item.orders) }, { name: 'Follow-up', data: trendBuckets.map((item) => item.followUps) }]} />
          <div className="data-table-wrap"><table><caption>Reports by conversation or import date</caption><thead><tr><th>Date</th><th>Visits</th><th>Orders</th><th>Follow-ups</th></tr></thead><tbody>{trendBuckets.map((row) => <tr key={row.label}><th scope="row">{row.label}</th><td>{row.visits}</td><td>{row.orders}</td><td>{row.followUps}</td></tr>)}</tbody></table></div>
        </section>
        <section className="chart-panel"><div className="chart-heading"><div><h3>Signal reach</h3><p>Distinct visits supporting each normalized theme.</p></div></div>
          <ReportChart type="bar" height={Math.max(230, categoryRows.length * 38)} options={categoryOptions} series={[{ name: 'Distinct visits', data: categoryRows.map((row) => row.distinctVisitCount) }]} />
          <div className="data-table-wrap"><table><caption>Signal counts</caption><thead><tr><th>Signal</th><th>Visits</th><th>Mentions</th></tr></thead><tbody>{categoryRows.map((row) => <tr key={row.taxonomyKey}><th scope="row"><button className="table-link" onClick={() => selectSignal(row.taxonomyKey)}>{row.title}</button></th><td>{row.distinctVisitCount}</td><td>{row.rawMentionCount}</td></tr>)}</tbody></table></div>
        </section>
        <section className="chart-panel"><div className="chart-heading"><div><h3>Declared visit outcomes</h3><p>Conversation-stated outcome; conditional interest is not an order.</p></div></div>
          <ReportChart type="donut" height={244} options={outcomeOptions} series={outcomeRows.map((item) => item.count)} />
          <div className="outcome-list">{outcomeRows.map((row) => <div key={row.label}><span className="legend-dot" style={{ background: row.color }}/><span>{row.label}</span><strong>{row.count}</strong></div>)}</div>
        </section>
        <section className="chart-panel chart-wide"><div className="chart-heading"><div><h3>Shopkeeper response cues</h3><p>Transcript cues for review; “unknown” means the text did not support a clear cue.</p></div></div>
          <ReportChart type="bar" height={132} options={sentimentOptions} series={sentimentRows.map((row, index) => ({ name: row.label, data: [row.count], color: [palette.green, '#829889', '#d2a45e', '#b16a44', '#b7c0ba'][index] }))} />
          <div className="cue-list">{sentimentRows.map((row, index) => <span key={row.label}><i style={{ background: [palette.green, '#829889', '#d2a45e', '#b16a44', '#b7c0ba'][index] }}/>{row.label} <strong>{row.count}</strong></span>)}</div>
        </section>
        <section className="chart-panel chart-wide"><div className="chart-heading"><div><h3>Pack and product demand by territory</h3><p>Cells count visits with a supported mention. Zero means no mention was extracted here, not that a need is absent.</p></div></div>
          <ReportChart type="heatmap" height={Math.max(190, demandHeatmapSeries.length * 44)} options={demandHeatmapOptions} series={demandHeatmapSeries} />
          <div className="data-table-wrap"><table><caption>Demand signal matrix · distinct visits</caption><thead><tr><th scope="col">Territory</th>{demandSignals.map((signal) => <th scope="col" key={signal.taxonomyKey}>{signal.title}</th>)}</tr></thead><tbody>{demandHeatmapSeries.map((territoryRow) => <tr key={territoryRow.name}><th scope="row">{territoryRow.name}</th>{territoryRow.data.map((cell, index) => <td key={`${territoryRow.name}-${index}`}>{cell.y}</td>)}</tr>)}</tbody></table></div>
        </section>
        <section className="chart-panel"><div className="chart-heading"><div><h3>Objection and competitor mix</h3><p>Distinct visits; repeated mentions stay in the detail column.</p></div></div>
          <ReportChart type="bar" height={Math.max(210, objectionRows.length * 36)} options={objectionOptions} series={[{ name: 'Distinct visits', data: objectionRows.map((row) => row.distinctVisitCount) }]} />
          <div className="data-table-wrap"><table><caption>Objection and competitor detail</caption><thead><tr><th scope="col">Theme</th><th scope="col">Visits</th><th scope="col">Mentions</th><th scope="col">Reach</th></tr></thead><tbody>{objectionRows.map((row) => <tr key={row.taxonomyKey}><th scope="row"><button className="table-link" onClick={() => selectSignal(row.taxonomyKey)}>{row.title}</button></th><td>{row.distinctVisitCount}</td><td>{row.rawMentionCount}</td><td>{Math.round(row.share * 100)}%</td></tr>)}</tbody></table></div>
        </section>
        <section className="chart-panel"><div className="chart-heading"><div><h3>Agreed follow-up timing</h3><p>Timing from explicitly recorded next steps in the selected conversations.</p></div></div>
          <ReportChart type="bar" height={220} options={followUpTimingOptions} series={[{ name: 'Follow-ups', data: followUpTimingRows.map((row) => row.count) }]} />
          <div className="data-table-wrap"><table><caption>Follow-up timing</caption><thead><tr><th scope="col">Due window</th><th scope="col">Commitments</th></tr></thead><tbody>{followUpTimingRows.map((row) => <tr key={row.label}><th scope="row">{row.label}</th><td>{row.count}</td></tr>)}</tbody></table></div>
        </section>
        <section className="chart-panel chart-wide"><div className="chart-heading"><div><h3>Coaching indicators with evidence</h3><p>Count visits with transcript-backed coaching signals. These are not representative rankings.</p></div></div>
          <ReportChart type="bar" height={196} options={coachingOptions} series={[{ name: 'Visits with evidence', data: coachingRows.map((row) => row.distinctVisitCount) }]} />
          <div className="data-table-wrap"><table><caption>Coaching rubric coverage</caption><thead><tr><th scope="col">Rubric</th><th scope="col">Visits with evidence</th><th scope="col">Evidence records</th><th scope="col">Example note</th></tr></thead><tbody>{coachingRows.map((row) => <tr key={row.rubricKey}><th scope="row">{row.label}</th><td>{row.distinctVisitCount}</td><td>{row.evidenceCount}</td><td>{row.examples[0] ? `${row.examples[0].outletName}: ${row.examples[0].note}` : 'No supported example in this period'}</td></tr>)}</tbody></table></div>
        </section>
      </div>
      <section className="insight-review-table"><div className="section-heading"><div><h2>Follow-ups from the conversation</h2><p>Only explicit commitments are listed; no inferred due dates are added.</p></div><button className="text-action" onClick={() => setView('visits')}>See all visits <Icon name="arrow"/></button></div>
        <div className="follow-up-list">{conversations.filter((item) => item.outcome === 'follow_up').map((item) => <button className="follow-up-row" key={item.id} onClick={() => openVisit(item.id)}><span className="follow-up-indicator"/><span className="follow-up-main"><strong>{item.nextAction ?? item.summary}</strong><small>{item.outletName} · {item.representativeName ?? item.representativeId} · {item.territoryName ?? item.territoryId}</small></span><span className="follow-up-due">{item.nextActionDue ? formatDueLabel(item.nextActionDue) : 'Date not stated'}</span><Icon name="arrow"/></button>)}{!conversations.some((item) => item.outcome === 'follow_up') && <p className="empty-inline">No follow-ups in this filtered period.</p>}</div>
      </section>
    </>;
  }

  function renderTeam() {
    return <section className="directory-section"><div className="directory-header"><div><h2>Field activity, with source evidence</h2><p>Use the representative filter to narrow the team view. No composite rep score is calculated.</p></div><span className="synthetic-badge">{conversations.some((item) => item.source === 'manual_transcript') ? 'SYNTHETIC + IMPORTED REPORTS' : 'SYNTHETIC DATA'}</span></div>
      <div className="team-table-wrap"><table><caption>Visits and conversation evidence by representative</caption><thead><tr><th>Representative</th><th>Visits</th><th>Explicit orders</th><th>Follow-ups</th><th>Evidence-linked signals</th><th>Territories</th></tr></thead><tbody>{representativeRows.map((rep) => <tr key={rep.name}><th scope="row"><span className="rep-cell"><i>{rep.initials}</i>{rep.name}</span></th><td>{rep.visits}</td><td>{rep.orders}</td><td>{rep.followUps}</td><td>{rep.evidence}</td><td>{[...new Set(conversations.filter((item) => (item.representativeName ?? item.representativeId) === rep.name).map((item) => item.territoryName ?? item.territoryId))].join(', ') || '—'}</td></tr>)}</tbody></table></div>
      <div className="team-evidence-note"><strong>Evidence-led coaching</strong><p>Each conversation record includes supported discovery, objection response, and close/next-step signals where available. Review the cited segments before coaching; an absent signal means it was not found in the transcript, not that the rep failed.</p></div>
    </section>;
  }

  function renderFieldPwaCaptures() {
    return <section className="field-pwa-captures" aria-labelledby="field-pwa-captures-title" aria-busy={captureRefreshing}>
      <div className="field-pwa-header">
        <div><h2 id="field-pwa-captures-title">Field PWA captures</h2><p>Real recording metadata, uploaded audio, and transcripts from the stored conversation. These recordings stay separate from seeded synthetic reports.</p></div>
        <div className="field-pwa-actions">
          <span className={`field-pwa-api-status ${captureApiState}`} role="status" aria-live="polite"><i aria-hidden="true"/>{captureApiState === 'loading' ? 'Connecting to API' : captureApiState === 'available' ? 'API connected' : 'API unavailable'}</span>
          <button className="button" type="button" onClick={() => void refreshFieldCaptures()} disabled={captureRefreshing}>{captureRefreshing ? 'Refreshing…' : 'Refresh'}</button>
        </div>
      </div>
      <div className="field-pwa-runtime" aria-label="API capabilities">
        {captureRuntime?.persistence === 'in-memory-demo' && <span>In-memory demo metadata</span>}
        {captureRuntime?.uploads === 'not-configured' && <span className="field-pwa-upload-unavailable">S3 upload not configured</span>}
        {captureRuntime?.uploads === 'configured' && <span className="field-pwa-upload-ready">S3 upload configured</span>}
        {captureRuntime?.analysis === 'not-configured' && <span className="field-pwa-upload-unavailable">OpenAI transcription not configured</span>}
        {captureRuntime?.analysis === 'configured' && <span className="field-pwa-upload-ready">OpenAI transcription configured</span>}
        {captureLastUpdated && <span>Last API response {formatDateTime(captureLastUpdated.toISOString())}</span>}
      </div>
      {capturePlaybackError && <div className="field-pwa-alert" role="alert">{capturePlaybackError}</div>}
      {captureApiState === 'unavailable' && <div className="field-pwa-alert" role="alert"><strong>Capture API unavailable.</strong><span>{captureError ?? 'The API could not be reached.'}</span>{captureLastUpdated && <small>Showing the last successful metadata response from {formatDateTime(captureLastUpdated.toISOString())}.</small>}</div>}
      {captureApiState === 'loading' && fieldCaptures.length === 0 && <div className="field-pwa-loading" role="status"><i/><i/><span>Loading capture metadata…</span></div>}
      {captureApiState === 'available' && fieldCaptures.length === 0 && <div className="field-pwa-empty"><strong>No Field PWA capture metadata has arrived.</strong><span>Record a consented shop visit in the PWA and bring the device online to sync it here.</span></div>}
      {fieldCaptures.length > 0 && !filteredFieldCaptures.length && <div className="field-pwa-empty"><strong>No captures match the current filters.</strong><span>Clear territory, representative, date, or search filters to show uploaded and queued recordings.</span></div>}
      {filteredFieldCaptures.length > 0 && <>
        <div className="field-pwa-record-labels" aria-hidden="true"><span>Outlet and route</span><span>Capture details</span><span>API states</span></div>
        <div className="field-pwa-record-list">
          {filteredFieldCaptures.map((recording) => {
            const sync = syncStateDetails[recording.syncState];
            const analysis = analysisStateDetails[recording.analysisState];
            return <article className="field-pwa-record" key={recording.id}>
              <div className="field-pwa-identity"><strong>{recording.outletName}</strong><span>Representative {recording.representativeId}</span><span>Territory {recording.territoryId}</span><small>Recording ID {recording.id}</small></div>
              <div className="field-pwa-timing"><div><span>Duration</span><strong>{formatDuration(Math.round(recording.durationSeconds))}</strong></div><div><span>PWA start time</span><time dateTime={recording.startedAt}>{formatDateTime(recording.startedAt)}</time></div></div>
              <div className="field-pwa-state-grid">
                <div className={`field-pwa-state sync-${recording.syncState}`}><span>Sync state</span><strong>syncState={sync.label}</strong><small>{sync.detail}</small></div>
                <div className={`field-pwa-state analysis-${recording.analysisState}`}><span>Transcription</span><strong>{analysis.label}</strong><small>{analysis.detail}</small></div>
              </div>
              <div className="field-pwa-audio-actions">{recording.syncState === 'uploaded'
                ? <><button className="live-audio-button" type="button" onClick={() => void toggleCaptureAudio(recording.id)} disabled={captureAudioLoading === recording.id}>{captureAudioLoading === recording.id ? 'Loading audio…' : activeCaptureAudio?.id === recording.id ? 'Close audio' : 'Listen to uploaded audio'}</button><button className="live-transcript-button" type="button" aria-expanded={selectedCaptureTranscriptId === recording.id} aria-controls={`recording-transcript-${recording.id}`} onClick={() => toggleCaptureTranscript(recording.id)}>{selectedCaptureTranscriptId === recording.id ? 'Hide transcript' : hasCompletedCaptureTranscript(recording.id) ? 'View transcript' : 'Check transcript'}</button></>
                : <span className={`live-upload-state sync-${recording.syncState}`}>{recording.syncState === 'queued' ? 'Audio queued for S3' : recording.syncState === 'uploading' ? 'Audio uploading' : 'Upload needs attention'}</span>}</div>
              {activeCaptureAudio?.id === recording.id && <audio className="field-pwa-audio-player" controls preload="none" src={activeCaptureAudio.url} aria-label={`Uploaded recording from ${recording.outletName}`}/>}
              <div id={`recording-transcript-${recording.id}`} className="field-pwa-transcript-slot" hidden={selectedCaptureTranscriptId !== recording.id}>{renderCaptureTranscript(recording.id)}</div>
            </article>;
          })}
        </div>
        {fieldCaptureTotal > fieldCaptures.length && <p className="field-pwa-pagination-note">Showing up to 100 of {fieldCaptureTotal} API records.</p>}
      </>}
    </section>;
  }

  function renderVisits() {
    const rows = [...conversations].sort((a, b) => conversationDateKey(b).localeCompare(conversationDateKey(a)));
    return <>{renderFieldPwaCaptures()}<section className="directory-section"><div className="directory-header"><div><h2>Conversation report history</h2><p>Seeded examples and manually imported transcript reports are labeled by source. Text-only imports have no audio or inferred duration.</p></div><span className="synthetic-badge">{rows.some((item) => item.source === 'manual_transcript') ? 'SYNTHETIC + IMPORTED REPORTS' : 'SYNTHETIC DATA'}</span></div>
      <div className="visit-list">{rows.map((item) => <button className="visit-row" key={item.id} onClick={() => openVisit(item.id)}><span className={`visit-status ${item.outcome}`} aria-hidden="true"/><span className="visit-cell visit-outlet"><strong>{item.outletName}</strong><small>{item.city ?? 'Location not provided'} · {item.territoryName ?? item.territoryId}</small></span><span className="visit-cell"><strong>{item.representativeName ?? item.representativeId}</strong><small>{item.source === 'manual_transcript' ? item.conversationDate ? `Conversation ${formatDateOnly(item.conversationDate)}` : `Imported ${formatDateTime(item.createdAt)}` : formatDateTime(item.createdAt)} <span className={`source-chip ${item.source === 'manual_transcript' ? 'manual' : 'synthetic'}`}>{item.source === 'manual_transcript' ? 'Manual transcript' : 'Seeded demo'}</span></small></span><span className="visit-cell"><strong>{outcomeLabel(item.outcome)}</strong><small>{item.durationSeconds === undefined ? 'Duration not provided' : `${formatDuration(item.durationSeconds)} conversation`}</small></span><span className="visit-cell visit-summary"><strong>{item.summary}</strong><small>{item.insights.length} evidence-backed insight{item.insights.length === 1 ? '' : 's'}</small></span><Icon name="arrow"/></button>)}{!rows.length && <div className="empty-inline">No visits match the current filters.</div>}</div>
    </section></>;
  }

  return <div className="manager-shell">
    <aside className="workspace-rail">
      <div className="brand-lockup"><span className="brand-mark">FS</span><span><strong>Field Source</strong><small>MANAGER</small></span></div>
      <nav aria-label="Main navigation" className="primary-nav">
        <button title="Overview" aria-label="Overview" className={view === 'overview' ? 'active' : ''} onClick={() => setView('overview')}><Icon name="grid"/>Overview</button>
        <button title="Conversation insights" aria-label="Conversation insights" className={view === 'insights' ? 'active' : ''} onClick={() => setView('insights')}><Icon name="signal"/>Conversation insights</button>
        <button title="Field team" aria-label="Field team" className={view === 'team' ? 'active' : ''} onClick={() => setView('team')}><Icon name="team"/>Field team</button>
        <button title="Visit history" aria-label="Visit history" className={view === 'visits' ? 'active' : ''} onClick={() => setView('visits')}><Icon name="list"/>Visit history</button>
      </nav>
      <div className="rail-status"><span className="rail-status-icon"><i/></span><span><strong>Demo workspace</strong><small>Seeded + imported reports</small></span></div>
      <div className="rail-user"><span className="user-avatar">{admin.displayName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('')}</span><span><strong>{admin.displayName}</strong><small>{admin.email}</small></span><button aria-label="Sign out" title="Sign out" className="logout-button" type="button" onClick={onLogout} disabled={logoutBusy}>{logoutBusy ? 'Working' : 'Sign out'}</button></div>
    </aside>

    <main className="workspace-main">
      {logoutError && <p className="auth-inline-error" role="alert">Sign out failed: {logoutError}</p>}
      <header className="topbar"><div className="breadcrumbs"><span>Reports</span><i>/</i><strong>{view === 'team' ? 'Field team' : view === 'visits' ? 'Visit history' : view === 'overview' ? 'Overview' : 'Conversation insights'}</strong></div>
        <div className="topbar-tools">{renderFilters()}<span className="demo-pill"><i/>{manualTranscripts.length ? 'DEMO + TRANSCRIPTS' : 'SYNTHETIC DEMO'}</span></div>
      </header>
      <div className="page-content">
        <div className="page-title-row"><div><h1>{viewTitle[view]}</h1><p>{view === 'insights' ? selectedSignal ? <><strong>{selectedSignal.rawMentionCount} mentions</strong> from <strong>{selectedSignal.distinctOutletCount} unique outlets</strong> across {selectedSignal.territories.length} territories {period === '7' ? 'in the last 7 days' : period === '30' ? 'in the last 30 days' : 'in the selected report data'}. Findings link to their source conversation.</> : 'No supported signals in this range.' : view === 'team' ? 'Coverage, commitments, and evidence across the selected team.' : view === 'visits' ? 'Seeded examples, transcript reports, and live PWA captures are listed separately.' : 'Coverage, declared outcomes, and capture sync across the field team.'}</p></div>
          <div className="title-actions"><label className="search-control"><Icon name="search"/><span className="sr-only">Search outlets or representatives</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search outlet or rep"/></label>{view !== 'insights' && <button className="button" type="button" onClick={() => setView('insights')}>Import transcript</button>}<button className="button export-button" onClick={() => window.print()}><Icon name="print"/>Print report</button></div>
        </div>

        {view === 'overview' ? renderOverview() : view === 'insights' ? renderInsights() : view === 'team' ? renderTeam() : renderVisits()}
        <footer className="page-footnote"><span>{manualTranscripts.length ? `${demoDataNotice} Manual reports are derived from the imported text shown with each report.` : demoDataNotice}</span><span>Live uploaded audio stays separate from transcript-derived conversation reports.</span></footer>
      </div>
    </main>

    {detailVisit && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setVisitId(null); }}><section ref={dialogRef} className="visit-dialog" role="dialog" aria-modal="true" aria-labelledby="visit-title" tabIndex={-1}>
      <header className="dialog-header"><div><span className="dialog-kicker">{detailVisit.source === 'manual_transcript' ? `MANUAL TRANSCRIPT · ${manualTranscripts.find((item) => item.id === detailVisit.id)?.storageState === 's3' ? 'SOURCE IN S3' : 'TEXT ONLY'}` : 'SYNTHETIC TRANSCRIPT · NO AUDIO'}</span><h2 id="visit-title">{detailVisit.outletName}</h2><p>{detailVisit.representativeName ?? detailVisit.representativeId} · {detailVisit.territoryName ?? detailVisit.territoryId} · {detailVisit.source === 'manual_transcript' ? detailVisit.conversationDate ? `Conversation ${formatDateOnly(detailVisit.conversationDate)}` : `Imported ${formatDateTime(detailVisit.createdAt)}` : formatDateTime(detailVisit.createdAt)}</p></div><button ref={dialogCloseRef} className="icon-button close-button" aria-label="Close transcript" onClick={() => setVisitId(null)}><Icon name="close"/></button></header>
      <div className="dialog-meta"><span className="outcome-tag">{outcomeLabel(detailVisit.outcome)}</span><span>{detailVisit.durationSeconds === undefined ? 'Duration not provided' : formatDuration(detailVisit.durationSeconds)}</span>{detailVisit.confirmedOrderValueInr !== undefined && <strong>₹{formatCount(detailVisit.confirmedOrderValueInr)} explicitly stated</strong>}</div>
      <p className="dialog-summary">{detailVisit.summary}</p>
      <div className="transcript-list" aria-label="Transcript segments">{detailVisit.transcript.map((segment) => {
        const isEvidence = detailVisit.outcomeEvidenceSegmentIds.includes(segment.id)
          || (detailVisit.nextActionEvidenceSegmentIds?.includes(segment.id) ?? false)
          || detailVisit.insights.some((insight) => insight.evidence.some((evidence) => evidence.segmentIds.includes(segment.id)))
          || detailVisit.coachingSignals.some((signal) => signal.evidenceSegmentIds.includes(segment.id));
        return <article className={`transcript-segment ${segment.speaker} ${isEvidence ? 'is-evidence' : ''}`} key={segment.id}><time>{segment.startMs === undefined ? 'Time not provided' : minutes(Math.floor(segment.startMs / 1000))}</time><div><span className="speaker-label">{segment.speaker === 'shopkeeper' ? 'Shopkeeper' : segment.speaker === 'representative' ? detailVisit.representativeName ?? detailVisit.representativeId : 'Unidentified speaker'}</span><p>{segment.text}</p></div>{isEvidence && <span className="segment-marker">Evidence</span>}</article>;
      })}</div>
      {originalTranscriptText && <details className="source-transcript-raw"><summary>Show original imported transcript</summary><pre>{originalTranscriptText}</pre></details>}
      <div className="dialog-insights"><h3>Extracted signals and coaching evidence</h3>{detailVisit.insights.map((insight) => <div className="dialog-insight" key={insight.id}><span className={`category-tag category-${insight.category}`}>{categoryLabel(insight.category)}</span><strong>{insight.title}</strong><p>{insight.summary}</p><small>{insight.explicitness} · {insight.confidence} confidence · {insight.mentionCount} supported mention{insight.mentionCount === 1 ? '' : 's'}</small>{insight.evidence.map((evidence) => <blockquote key={evidence.segmentIds.join('-')}>{evidence.quote}</blockquote>)}</div>)}
        {detailVisit.coachingSignals.length > 0 && <div className="coaching-details"><h4>Coaching evidence</h4>{detailVisit.coachingSignals.map((item) => <p key={item.rubricKey}><strong>{item.label}</strong><span>{item.note}</span></p>)}</div>}
      </div>
      <footer className="dialog-footer"><span>Factual claims are grounded in transcript segments. Review uncertainty before action.</span><button className="button" onClick={() => setVisitId(null)}>Done</button></footer>
    </section></div>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><ManagerApp/></StrictMode>);
