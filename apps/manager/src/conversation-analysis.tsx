import { hasUploadedAnalysisAudio } from '@itc/domain';
import type {
  ConversationAnalysisReport,
  InsightEvidence,
  OrderIntent,
  RecordingConversationAnalysis,
  RecordingMetadata,
  RecordingTranscript
} from '@itc/domain';
import './conversation-analysis.css';

export type ConversationAnalysisLoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; analysis: RecordingConversationAnalysis };

export type ConversationAnalysisReportState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; report: ConversationAnalysisReport };

interface ConversationAnalysisPanelProps {
  recording: RecordingMetadata;
  state: ConversationAnalysisLoadState;
  transcript?: RecordingTranscript;
  retrying: boolean;
  onRetryLoad: () => void;
  onRetryAnalysis: () => void;
  onReprocessAnalysis: () => void;
  onSeek: (startMs: number) => void;
}

const outcomeLabels: Record<RecordingConversationAnalysis['outcome'], string> = {
  order_placed: 'Order placed',
  follow_up: 'Follow-up agreed',
  no_order: 'No order stated',
  new_outlet: 'New outlet',
  not_stated: 'Outcome not stated'
};

const intentLabels: Record<OrderIntent, string> = {
  confirmed: 'Confirmed order',
  conditional: 'Conditional interest',
  considering: 'Considering',
  declined: 'Declined',
  unknown: 'Intent unclear'
};

const denoisingLabels = {
  not_started: 'Noise cleanup has not started.',
  initializing: 'Noise cleanup is starting.',
  processing: 'Noise cleanup is in progress.',
  ready: 'Denoised audio is ready for analysis.',
  failed: 'Noise cleanup failed. Raw audio was retained; it is not sent for diarization.',
  unsupported: 'This device could not run noise cleanup. Raw audio was retained; it is not sent for diarization.',
  incomplete: 'Noise cleanup did not finish. Raw audio was retained; it is not sent for diarization.'
} as const;

function formatCount(value: number): string {
  return new Intl.NumberFormat('en-IN').format(value);
}

function formatCurrency(value?: number): string | undefined {
  if (value === undefined) return undefined;
  return `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(value)}`;
}

function formatTime(startMs?: number, endMs?: number): string | undefined {
  if (startMs === undefined) return undefined;
  const format = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  return endMs === undefined ? format(startMs) : `${format(startMs)}–${format(endMs)}`;
}

function formatDueDate(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

function EvidenceQuote({
  evidence,
  transcript,
  onSeek
}: {
  evidence: InsightEvidence;
  transcript?: RecordingTranscript;
  onSeek: (startMs: number) => void;
}) {
  const turns = evidence.segmentIds
    .map((segmentId) => transcript?.turns?.find((turn) => turn.id === segmentId))
    .filter((turn): turn is NonNullable<typeof turn> => Boolean(turn));
  const time = formatTime(evidence.startMs ?? turns[0]?.startMs, evidence.endMs ?? turns.at(-1)?.endMs);
  const speakers = [...new Set(turns.map((turn) => turn.speaker))];
  const seekTime = evidence.startMs ?? turns[0]?.startMs;

  return <blockquote className="conversation-evidence">
    <p>“{evidence.quote}”</p>
    <footer>
      {speakers.length > 0 && <span>{speakers.join(', ')}</span>}
      {time && seekTime !== undefined
        ? <button type="button" className="conversation-evidence-link" onClick={() => onSeek(seekTime)}>{time} · Play evidence</button>
        : time && <span>{time}</span>}
      {!turns.length && <span>Transcript turn reference unavailable</span>}
    </footer>
  </blockquote>;
}

function SignalDetails({
  title,
  summary,
  confidence,
  explicitness,
  evidence,
  transcript,
  onSeek,
  metadata
}: {
  title: string;
  summary?: string;
  confidence?: string;
  explicitness?: string;
  evidence: InsightEvidence[];
  transcript?: RecordingTranscript;
  onSeek: (startMs: number) => void;
  metadata?: string[];
}) {
  return <article className="conversation-finding">
    <div className="conversation-finding-heading"><h4>{title}</h4>{confidence && <span className={`conversation-confidence confidence-${confidence}`}>{confidence} confidence</span>}</div>
    {summary && <p className="conversation-finding-summary">{summary}</p>}
    <p className="conversation-finding-meta">{[explicitness, ...(metadata ?? [])].filter(Boolean).join(' · ')}</p>
    {evidence.length > 0
      ? evidence.map((item, index) => <EvidenceQuote key={`${item.segmentIds.join('-')}-${index}`} evidence={item} transcript={transcript} onSeek={onSeek}/>)
      : <p className="conversation-analysis-note">No transcript evidence was attached to this finding.</p>}
  </article>;
}

function EmptyAnalysisExplanation({ recording }: { recording: RecordingMetadata }) {
  const denoising = recording.denoisedAnalysisAudio;
  if (denoising && denoising.state !== 'ready') {
    return <p className="conversation-analysis-message">{denoisingLabels[denoising.state]}</p>;
  }
  if (recording.conversationAnalysisState === 'queued' || recording.conversationAnalysisState === 'processing') {
    return <p className="conversation-analysis-message" role="status">Conversation analysis is {recording.conversationAnalysisState}.</p>;
  }
  if (recording.conversationAnalysisState === 'failed') {
    return <p className="conversation-analysis-message" role="status">Conversation analysis did not complete. The original recording remains available.</p>;
  }
  return <p className="conversation-analysis-message">No production analysis is available for this recording yet.</p>;
}

export function ConversationAnalysisPanel({
  recording,
  state,
  transcript,
  retrying,
  onRetryLoad,
  onRetryAnalysis,
  onReprocessAnalysis,
  onSeek
}: ConversationAnalysisPanelProps) {
  const denoising = recording.denoisedAnalysisAudio;
  const analysis = state.kind === 'loaded' ? state.analysis : undefined;
  const confirmedOrders = analysis?.confirmedOrders.filter((order) => order.intent === 'confirmed') ?? [];
  const qualifiedOrders = analysis?.confirmedOrders.filter((order) => order.intent !== 'confirmed') ?? [];

  return <section className="conversation-analysis-panel" aria-label="Production conversation analysis" aria-live="polite">
    <div className="conversation-analysis-heading">
      <div><h3>Real recording analysis</h3><p>Production analysis · original recording retained</p></div>
      {analysis && hasUploadedAnalysisAudio(recording) && <span className={`conversation-analysis-status status-${analysis.state}`}>{analysis.state}</span>}
    </div>
    {denoising && <p className={`conversation-denoising-state denoising-${denoising.state}`}>
      <strong>Audio preparation:</strong> {denoising.state === 'ready'
        ? `Denoised copy ready${denoising.model ? ` · ${denoising.model}${denoising.modelVersion ? ` ${denoising.modelVersion}` : ''}` : ''}.`
        : denoisingLabels[denoising.state]}
    </p>}
    {denoising?.errorCode && <p className="conversation-analysis-note">Audio preparation reason: {denoising.errorCode}</p>}
    {state.kind === 'idle' && <div className="conversation-analysis-message"><p>Analysis has not been loaded.</p><button type="button" className="transcript-action" onClick={onRetryLoad}>Load analysis</button></div>}
    {state.kind === 'loading' && <div className="conversation-analysis-message" role="status"><span className="conversation-analysis-skeleton" aria-hidden="true"/><span>Loading analysis for this recording…</span></div>}
    {state.kind === 'error' && <div className="conversation-analysis-message" role="alert"><p>{state.message}</p><button type="button" className="transcript-action" onClick={onRetryLoad}>Try loading again</button></div>}
    {analysis?.state === 'queued' && <p className="conversation-analysis-message" role="status">Diarization and transcription are complete. The sales analysis is waiting to run.</p>}
    {analysis?.state === 'processing' && <p className="conversation-analysis-message" role="status">Extracting evidence-backed visit outcomes and sales signals…</p>}
    {analysis?.state === 'not_started' && analysis.errorMessage && <p className="conversation-analysis-message" role="status">{analysis.errorMessage}</p>}
    {analysis?.state === 'failed' && <div className="conversation-analysis-message" role="alert">
      <p>{analysis.errorMessage ?? 'Conversation analysis failed. The original recording and transcript remain available.'}</p>
      {hasUploadedAnalysisAudio(recording) && analysis.retryable && <button type="button" className="transcript-action" onClick={onRetryAnalysis} disabled={retrying}>{retrying ? 'Retrying…' : 'Retry analysis'}</button>}
      {hasUploadedAnalysisAudio(recording) && <button type="button" className="transcript-action" onClick={onReprocessAnalysis} disabled={retrying}>{retrying ? 'Starting…' : 'Reprocess analysis'}</button>}
    </div>}
    {analysis?.state === 'completed' && <>
      <div className="conversation-outcome">
        <span>Visit outcome</span><strong>{outcomeLabels[analysis.outcome]}</strong>
        <small>{analysis.outcomeExplicitness} · {analysis.outcomeConfidence} confidence</small>
      </div>
      {analysis.summary && <p className="conversation-analysis-summary">{analysis.summary}</p>}
      {analysis.outcomeEvidence.length > 0 && <div className="conversation-analysis-evidence">
        <h4>Outcome evidence</h4>
        {analysis.outcomeEvidence.map((item, index) => <EvidenceQuote key={`${item.segmentIds.join('-')}-${index}`} evidence={item} transcript={transcript} onSeek={onSeek}/>) }
      </div>}

      <section className="conversation-analysis-group" aria-labelledby={`confirmed-orders-${recording.id}`}>
        <h4 id={`confirmed-orders-${recording.id}`}>Confirmed orders <span>{confirmedOrders.length}</span></h4>
        {confirmedOrders.length ? confirmedOrders.map((order) => <SignalDetails
          key={order.id}
          title={[order.productName, order.brand, order.packDescription].filter(Boolean).join(' · ') || 'Confirmed order'}
          summary={[order.quantity !== undefined ? `${formatCount(order.quantity)} ${order.quantityUnit ?? 'units'}` : undefined, formatCurrency(order.unitPriceInr) ? `${formatCurrency(order.unitPriceInr)} per unit` : undefined, formatCurrency(order.totalValueInr) ? `${formatCurrency(order.totalValueInr)} total` : undefined].filter(Boolean).join(' · ')}
          confidence={order.confidence}
          explicitness="confirmed"
          evidence={order.evidence}
          transcript={transcript}
          onSeek={onSeek}
        />) : <p className="conversation-analysis-note">No confirmed order was extracted. Conditional and undecided interest is listed separately.</p>}
      </section>

      {qualifiedOrders.length > 0 && <section className="conversation-analysis-group" aria-labelledby={`qualified-orders-${recording.id}`}>
        <h4 id={`qualified-orders-${recording.id}`}>Other purchase intent <span>{qualifiedOrders.length}</span></h4>
        {qualifiedOrders.map((order) => <SignalDetails
          key={order.id}
          title={[order.productName, order.brand, order.packDescription].filter(Boolean).join(' · ') || intentLabels[order.intent]}
          summary={[intentLabels[order.intent], order.quantity !== undefined ? `${formatCount(order.quantity)} ${order.quantityUnit ?? 'units'}` : undefined, formatCurrency(order.totalValueInr)].filter(Boolean).join(' · ')}
          confidence={order.confidence}
          explicitness={order.intent}
          evidence={order.evidence}
          transcript={transcript}
          onSeek={onSeek}
        />)}
      </section>}

      <section className="conversation-analysis-group" aria-labelledby={`sales-signals-${recording.id}`}>
        <h4 id={`sales-signals-${recording.id}`}>Sales signals <span>{analysis.salesSignals.length}</span></h4>
        {analysis.salesSignals.length ? analysis.salesSignals.map((signal) => <SignalDetails
          key={signal.id}
          title={signal.title}
          summary={signal.summary}
          confidence={signal.confidence}
          explicitness={signal.explicitness}
          metadata={[
            signal.status ? `Status: ${signal.status}` : undefined,
            signal.productName,
            signal.brand,
            signal.packDescription,
            signal.explicitCount !== undefined ? `${formatCount(signal.explicitCount)} ${signal.countUnit ?? 'reported'}` : undefined,
            `${formatCount(signal.mentionCount)} supported mention${signal.mentionCount === 1 ? '' : 's'}`
          ].filter((item): item is string => Boolean(item))}
          evidence={signal.evidence}
          transcript={transcript}
          onSeek={onSeek}
        />) : <p className="conversation-analysis-note">No supported sales signals were extracted from this transcript.</p>}
      </section>

      {analysis.nextAction && <section className="conversation-analysis-group">
        <h4>Agreed next step</h4>
        <SignalDetails
          title={analysis.nextAction}
          summary={formatDueDate(analysis.nextActionDue) ? `Due ${formatDueDate(analysis.nextActionDue)}` : 'No due date stated'}
          evidence={analysis.nextActionEvidence}
          transcript={transcript}
          onSeek={onSeek}
        />
      </section>}

      {analysis.coachingSignals.length > 0 && <section className="conversation-analysis-group">
        <h4>Coaching evidence</h4>
        {analysis.coachingSignals.map((signal) => <SignalDetails
          key={signal.rubricKey}
          title={signal.label}
          summary={signal.note}
          confidence={signal.confidence}
          evidence={signal.evidenceSegmentIds.flatMap((id) => {
            const turn = transcript?.turns?.find((item) => item.id === id);
            return turn ? [{ segmentIds: [id], quote: turn.text, startMs: turn.startMs, endMs: turn.endMs }] : [];
          })}
          transcript={transcript}
          onSeek={onSeek}
        />)}
        <p className="conversation-analysis-note">These are evidence cues for review, not a representative score.</p>
      </section>}

      <div className="conversation-analysis-provenance">{analysis.provider} · {analysis.model} · version {analysis.analysisVersion} · completed {new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(analysis.completedAt ?? analysis.updatedAt))}</div>
      {hasUploadedAnalysisAudio(recording) && <button type="button" className="transcript-action" onClick={onReprocessAnalysis} disabled={retrying}>{retrying ? 'Starting…' : 'Reprocess analysis'}</button>}
    </>}
    {state.kind === 'loaded' && analysis?.state === 'not_started' && !analysis.errorMessage && <EmptyAnalysisExplanation recording={recording}/>}
  </section>;
}

function breakdownLabel(values: Record<string, number>): string {
  return Object.entries(values).filter(([, value]) => value > 0).map(([key, value]) => `${key} ${formatCount(value)}`).join(' · ') || 'None';
}

function signalLabel(taxonomyKey: string): string {
  return taxonomyKey.split('.').slice(1).join(' ')
    .replaceAll(/[._-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase()) || taxonomyKey;
}

export function ConversationAnalysisReportPanel({
  state,
  periodLabel,
  onRetry
}: {
  state: ConversationAnalysisReportState;
  periodLabel: string;
  onRetry: () => void;
}) {
  return <section className="production-analysis-report" aria-labelledby="production-analysis-title" aria-busy={state.kind === 'loading'}>
    <header className="production-analysis-heading">
      <div><h2 id="production-analysis-title">Real recording analysis</h2><p>Evidence-backed findings from denoised field recordings · {periodLabel}</p></div>
      <span className="production-analysis-source">REAL PWA AUDIO</span>
    </header>
    <p className="production-analysis-scope">This report uses date, territory, and representative filters. Keyword search applies to the demo and parsed transcript list only.</p>
    {state.kind === 'loading' && <div className="production-analysis-loading" role="status"><span className="conversation-analysis-skeleton" aria-hidden="true"/>Loading real recording analysis…</div>}
    {state.kind === 'error' && <div className="production-analysis-empty" role="alert"><p>{state.message}</p><button type="button" className="transcript-action" onClick={onRetry}>Retry report</button></div>}
    {state.kind === 'loaded' && (() => {
      const { report } = state;
      const hasCaptures = report.captureCount > 0;
      const hasAnalysis = report.analyzedRecordingCount > 0;
      const orderOutcomes = report.outcomeCounts.order_placed;
      return <>
        <div className="production-analysis-counts" aria-label="Real recording analysis counts">
          <div><span>Recordings</span><strong>{formatCount(report.captureCount)}</strong><small>in this scope</small></div>
          <div><span>Analysis ready</span><strong>{formatCount(report.analyzedRecordingCount)}</strong><small>of {formatCount(report.captureCount)} recordings</small></div>
          <div><span>Pending</span><strong>{formatCount(report.pendingRecordingCount)}</strong><small>waiting or processing</small></div>
          <div><span>Failed</span><strong>{formatCount(report.failedRecordingCount)}</strong><small>needs attention</small></div>
        </div>
        {!hasCaptures && <p className="production-analysis-empty">No real field recordings match this date, territory, and representative scope. Synthetic fixtures and manual transcript reports are excluded here.</p>}
        {hasCaptures && !hasAnalysis && <p className="production-analysis-empty">No recording in this scope has completed sales analysis yet. Pending and failed counts above describe the current pipeline state.</p>}
        {hasAnalysis && <>
          <div className="production-analysis-outcomes">
            <div><span>Visit outcome</span><strong>{formatCount(orderOutcomes)}</strong><small>orders placed · {formatCount(report.outcomeCounts.follow_up)} follow-ups · {formatCount(report.outcomeCounts.no_order)} no order · {formatCount(report.outcomeCounts.new_outlet)} new outlets · {formatCount(report.outcomeCounts.not_stated)} not stated</small></div>
            <div><span>Confirmed orders</span><strong>{formatCount(report.confirmedOrderCount)}</strong><small>{formatCount(report.confirmedOrdersWithValueCount)} with explicit value; conditional interest excluded</small></div>
            <div><span>Explicit order value</span><strong>₹{formatCount(report.confirmedOrderValueInr)}</strong><small>across the analyzed recordings in scope</small></div>
            <div><span>Follow-up actions</span><strong>{formatCount(report.followUps.actionCount)}</strong><small>{formatCount(report.followUps.datedActionCount)} dated · {formatCount(report.followUps.overdueActionCount)} overdue</small></div>
          </div>
          <section className="production-analysis-signals" aria-labelledby="production-analysis-signals-title">
            <div className="production-analysis-subheading"><h3 id="production-analysis-signals-title">Recurring sales signals</h3><span>Among {formatCount(report.analyzedRecordingCount)} analyzed recordings</span></div>
            {report.signals.length ? <div className="production-analysis-table-wrap"><table className="production-analysis-table">
              <thead><tr><th scope="col">Signal</th><th scope="col">Mentions</th><th scope="col">Recordings</th><th scope="col">Outlets</th><th scope="col">Confidence</th><th scope="col">Finding type</th></tr></thead>
              <tbody>{report.signals.map((signal) => <tr key={signal.taxonomyKey}>
                <th scope="row">{signalLabel(signal.taxonomyKey)}<small>{signal.category.replaceAll('_', ' ')} · {signal.taxonomyKey}</small></th>
                <td>{formatCount(signal.mentionCount)}</td><td>{formatCount(signal.recordingCount)} / {formatCount(report.analyzedRecordingCount)}</td><td>{formatCount(signal.outletCount)}</td>
                <td>{breakdownLabel(signal.confidenceCounts)}</td><td>{breakdownLabel(signal.explicitnessCounts)}</td>
              </tr>)}</tbody>
            </table></div> : <p className="production-analysis-empty">No supported sales signals were extracted for this scope.</p>}
          </section>
          <div className="production-analysis-quality">
            <strong>Evidence coverage · outcomes, orders and sales signals</strong>
            <span>{formatCount(report.evidenceCoverage.evidenceLinkedFindingCount)} of {formatCount(report.evidenceCoverage.findingCount)} findings link to transcript evidence</span>
            <small>Confidence: {formatCount(report.evidenceCoverage.highConfidenceFindingCount)} high · {formatCount(report.evidenceCoverage.mediumConfidenceFindingCount)} medium · {formatCount(report.evidenceCoverage.lowConfidenceFindingCount)} low · {formatCount(report.evidenceCoverage.uncertainFindingCount)} uncertain</small>
          </div>
          {(report.territories.length > 0 || report.representatives.length > 0) && <details className="production-analysis-breakdowns">
            <summary>Coverage by territory and representative</summary>
            {report.territories.length > 0 && <div><h4>Territories</h4><ul>{report.territories.map((item) => <li key={item.id}><span>{item.name ?? item.id}</span><strong>{formatCount(item.analyzedRecordingCount)} / {formatCount(item.recordingCount)} analyzed</strong></li>)}</ul></div>}
            {report.representatives.length > 0 && <div><h4>Representatives</h4><p>Coverage only; no composite representative score is calculated.</p><ul>{report.representatives.map((item) => <li key={item.id}><span>{item.name ?? item.id}</span><strong>{formatCount(item.analyzedRecordingCount)} / {formatCount(item.recordingCount)} analyzed</strong></li>)}</ul></div>}
          </details>}
        </>}
      </>;
    })()}
  </section>;
}
