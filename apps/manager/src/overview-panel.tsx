import type { DemoConversation } from '@itc/demo-data';
import type { RecordingMetadata, SyncState } from '@itc/domain';
import './overview-panel.css';

export interface OverviewPanelProps {
  conversations: DemoConversation[];
  captures: RecordingMetadata[];
  totalCaptureCount: number;
  captureState: 'loading' | 'available' | 'unavailable';
  periodLabel: string;
  onOpenInsights: () => void;
  onOpenVisits: () => void;
}

const syncLabels: Record<SyncState, string> = {
  queued: 'Waiting for upload',
  uploading: 'Uploading',
  uploaded: 'Uploaded to S3',
  error: 'Upload needs attention'
};

function formatCount(value: number): string {
  return new Intl.NumberFormat('en-IN').format(value);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
  }).format(date);
}

function formatDueDate(value?: string): string {
  if (!value) return 'Date not stated';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Date not stated'
    : new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' }).format(date);
}

function outcomeName(outcome: DemoConversation['outcome']): string {
  if (outcome === 'order_placed') return 'Order placed';
  if (outcome === 'follow_up') return 'Follow-up agreed';
  if (outcome === 'new_outlet') return 'New outlet';
  if (outcome === 'not_stated') return 'Not stated';
  return 'No order';
}

function followUpItems(conversations: DemoConversation[]): DemoConversation[] {
  return conversations
    .filter((item) => item.outcome === 'follow_up')
    .sort((left, right) => {
      if (left.nextActionDue && right.nextActionDue) return left.nextActionDue.localeCompare(right.nextActionDue);
      if (left.nextActionDue) return -1;
      if (right.nextActionDue) return 1;
      return right.createdAt.localeCompare(left.createdAt);
    })
    .slice(0, 3);
}

export function OverviewPanel({
  conversations,
  captures,
  totalCaptureCount,
  captureState,
  periodLabel,
  onOpenInsights,
  onOpenVisits
}: OverviewPanelProps) {
  const outlets = new Set(conversations.map((item) => item.outletId ?? item.outletName.trim().toLocaleLowerCase()));
  const territories = new Set(conversations.map((item) => item.territoryName ?? item.territoryId));
  const representatives = new Set(conversations.map((item) => item.representativeName ?? item.representativeId));
  const outcomes = [
    { key: 'order_placed', label: 'Order placed', count: conversations.filter((item) => item.outcome === 'order_placed').length, tone: 'orders' },
    { key: 'follow_up', label: 'Follow-up agreed', count: conversations.filter((item) => item.outcome === 'follow_up').length, tone: 'followups' },
    { key: 'no_order', label: 'No order', count: conversations.filter((item) => item.outcome === 'no_order').length, tone: 'no-order' },
    { key: 'new_outlet', label: 'New outlet', count: conversations.filter((item) => item.outcome === 'new_outlet').length, tone: 'new-outlet' },
    { key: 'not_stated', label: 'Not stated', count: conversations.filter((item) => item.outcome === 'not_stated').length, tone: 'not-stated' }
  ];
  const maxOutcomeCount = Math.max(1, ...outcomes.map((item) => item.count));
  const explicitOrderValue = conversations.reduce((total, item) => total + (item.confirmedOrderValueInr ?? 0), 0);
  const explicitOrderCount = conversations.filter((item) => item.confirmedOrderValueInr !== undefined).length;
  const nextSteps = followUpItems(conversations);
  const latestCaptures = [...captures]
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, 4);
  // Read the source as a string so this isolated panel remains compatible while
  // the shared conversation source union grows (for example, manual_transcript).
  const sourceCounts = conversations.reduce((counts, item) => {
    const source = String(item.source);
    if (source === 'synthetic') counts.synthetic += 1;
    else if (source === 'manual_transcript') counts.manual += 1;
    else counts.other += 1;
    return counts;
  }, { synthetic: 0, manual: 0, other: 0 });

  return <section className="overview-panel" aria-labelledby="overview-panel-title">
    <header className="overview-intro">
      <div>
        <h2 id="overview-panel-title">Team coverage and operating actions</h2>
        <p>Route coverage, declared outcomes, and capture sync for {periodLabel.toLowerCase()}.</p>
      </div>
      <div className="overview-source-legend" aria-label="Conversation data sources">
        {sourceCounts.synthetic > 0 && <span><i className="overview-source-dot synthetic"/>Demo fixtures {formatCount(sourceCounts.synthetic)}</span>}
        {sourceCounts.manual > 0 && <span><i className="overview-source-dot manual"/>Manual transcript reports {formatCount(sourceCounts.manual)}</span>}
        {sourceCounts.other > 0 && <span><i className="overview-source-dot imported"/>Other imported reports {formatCount(sourceCounts.other)}</span>}
      </div>
    </header>

    <section className="overview-coverage" aria-label="Conversation coverage">
      <div className="overview-coverage-head">
        <div><h3>Coverage</h3><p>Conversation records in the selected report range</p></div>
        <button className="overview-link" type="button" onClick={onOpenInsights}>Open conversation insights</button>
      </div>
      <dl className="overview-coverage-grid">
        <div><dt>Conversations</dt><dd>{formatCount(conversations.length)}</dd></div>
        <div><dt>Outlets visited</dt><dd>{formatCount(outlets.size)}</dd></div>
        <div><dt>Territories covered</dt><dd>{formatCount(territories.size)}</dd></div>
        <div><dt>Representatives active</dt><dd>{formatCount(representatives.size)}</dd></div>
      </dl>
    </section>

    <div className="overview-workspace">
      <section className="overview-outcomes" aria-labelledby="overview-outcomes-title">
        <div className="overview-section-heading"><div><h3 id="overview-outcomes-title">Visit outcomes</h3><p>Counts from structured conversation reports</p></div></div>
        {conversations.length ? <>
          <div className="overview-outcome-list">
            {outcomes.map((item) => <div className="overview-outcome-row" key={item.key}>
              <span>{item.label}</span>
              <span className="overview-outcome-track" aria-hidden="true"><i className={item.tone} style={{ width: `${item.count / maxOutcomeCount * 100}%` }}/></span>
              <strong>{formatCount(item.count)}</strong>
            </div>)}
          </div>
          <p className="overview-order-value">Explicit order value <strong>₹{formatCount(explicitOrderValue)}</strong><span>{formatCount(explicitOrderCount)} stated value{explicitOrderCount === 1 ? '' : 's'}</span></p>
        </> : <p className="overview-empty">No conversation reports match this range. Live PWA captures are listed separately.</p>}
      </section>

      <section className="overview-next-steps" aria-labelledby="overview-next-steps-title">
        <div className="overview-section-heading"><div><h3 id="overview-next-steps-title">Agreed next steps</h3><p>Explicit follow-up commitments</p></div></div>
        {nextSteps.length ? <ul className="overview-next-step-list">
          {nextSteps.map((item) => <li key={item.id}>
            <div><strong>{item.nextAction ?? item.summary}</strong><span>{item.outletName} · {item.representativeName ?? item.representativeId}</span></div>
            <time dateTime={item.nextActionDue}>{formatDueDate(item.nextActionDue)}</time>
          </li>)}
        </ul> : <p className="overview-empty">No explicit follow-up commitments are recorded in this range.</p>}
      </section>
    </div>

    <section className="overview-captures" aria-labelledby="overview-captures-title">
      <div className="overview-capture-heading">
        <div><h3 id="overview-captures-title">Live device captures</h3><p>PWA sync status, separate from analyzed conversation reports</p></div>
        <button className="overview-link" type="button" onClick={onOpenVisits}>Open capture history</button>
      </div>
      {latestCaptures.length ? <div className="overview-capture-list">
        {latestCaptures.map((capture) => <article className="overview-capture-row" key={capture.id}>
          <div><strong>{capture.outletName}</strong><span>{capture.representativeId} · {capture.territoryId}</span></div>
          <time dateTime={capture.startedAt}>{formatDateTime(capture.startedAt)}</time>
          <span className={`overview-sync-state sync-${capture.syncState}`}>{syncLabels[capture.syncState]}</span>
          <span className={`overview-analysis-state analysis-${capture.analysisState}`}>{capture.analysisState === 'not_started' ? 'Analysis not started' : capture.analysisState === 'ready' ? 'Analysis ready' : capture.analysisState === 'error' ? 'Analysis failed' : capture.analysisState === 'transcribing' ? 'Transcribing' : 'Analyzing'}</span>
        </article>)}
      </div> : captureState === 'unavailable'
        ? <p className="overview-empty" role="status">The capture API is unavailable. Start or refresh the API to check device sync status.</p>
        : captureState === 'loading'
          ? <p className="overview-empty" role="status">Checking the capture API for device sync updates…</p>
          : totalCaptureCount > 0
            ? <p className="overview-empty">No captures match the selected date, territory, representative, or search.</p>
            : <p className="overview-empty">No live PWA capture metadata has arrived. Record a visit in the Field PWA and bring the device online to sync it here.</p>}
    </section>
  </section>;
}
