import { useState, type FormEvent } from 'react';
import './transcript-import-form.css';

export interface TranscriptImportInput {
  fileName: string;
  outletName: string;
  representativeId: string;
  territoryId: string;
  conversationDate?: string;
  transcriptText: string;
  consentConfirmed: true;
}

export interface TranscriptImportFormProps {
  busy: boolean;
  storageConfigured: boolean;
  status?: { kind: 'success' | 'error' | 'info'; message: string } | null;
  onIngest: (input: TranscriptImportInput) => Promise<void>;
}

export function TranscriptImportForm({ busy, storageConfigured, status, onIngest }: TranscriptImportFormProps) {
  const [fileName, setFileName] = useState('pasted-transcript.txt');
  const [outletName, setOutletName] = useState('');
  const [representativeId, setRepresentativeId] = useState('');
  const [territoryId, setTerritoryId] = useState('');
  const [conversationDate, setConversationDate] = useState('');
  const [transcriptText, setTranscriptText] = useState('');
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  async function loadFile(file?: File) {
    if (!file) return;
    setFileError(null);
    try {
      const text = await file.text();
      if (!text.trim()) {
        setFileError('This file is empty. Choose a transcript with text or paste the transcript below.');
        return;
      }
      setFileName(file.name || 'uploaded-transcript.txt');
      setTranscriptText(text);
    } catch {
      setFileError('The selected file could not be read. Try a plain text, Markdown, VTT, or SRT file.');
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!consentConfirmed || !transcriptText.trim()) return;
    void onIngest({
      fileName: fileName || 'pasted-transcript.txt',
      outletName: outletName.trim(),
      representativeId: representativeId.trim(),
      territoryId: territoryId.trim(),
      ...(conversationDate ? { conversationDate } : {}),
      transcriptText: transcriptText.trim(),
      consentConfirmed: true
    });
  }

  return <section className="transcript-import" aria-labelledby="transcript-import-title">
    <div className="transcript-import-heading">
      <div><h2 id="transcript-import-title">Import a transcript</h2><p>Run explainable demo rules on a consented transcript. Each finding links to its source line; this doesn’t upload or transcribe audio.</p></div>
      <span className={`transcript-storage-state ${storageConfigured ? 'configured' : 'local'}`}>{storageConfigured ? 'S3 configured · confirmed on submit' : 'In-memory demo mode'}</span>
    </div>
    {!storageConfigured && <p className="transcript-storage-note">Configure the API’s S3 bucket and credentials to persist the source file. Analysis can still be previewed in this demo session.</p>}
    <form className="transcript-import-form" onSubmit={submit}>
      <div className="transcript-file-row">
        <label className="transcript-file-picker">Choose transcript file<input type="file" accept=".txt,.md,.vtt,.srt,text/plain,text/vtt" onChange={(event) => { void loadFile(event.target.files?.[0]); }}/></label>
        <span className="transcript-file-name">{fileName === 'pasted-transcript.txt' && !transcriptText ? 'or paste text below' : fileName}</span>
      </div>
      {fileError && <p className="transcript-form-error" role="alert">{fileError}</p>}

      <div className="transcript-context-grid">
        <label>Outlet<input required maxLength={200} value={outletName} onChange={(event) => setOutletName(event.target.value)} placeholder="Shop or outlet name"/></label>
        <label>Representative<input required maxLength={128} value={representativeId} onChange={(event) => setRepresentativeId(event.target.value)} placeholder="Name or ID"/></label>
        <label>Territory<input required maxLength={128} value={territoryId} onChange={(event) => setTerritoryId(event.target.value)} placeholder="Route or area"/></label>
        <label>Conversation date (optional)<input type="date" value={conversationDate} onChange={(event) => setConversationDate(event.target.value)}/></label>
      </div>
      <label className="transcript-text-label">Transcript<textarea required minLength={1} value={transcriptText} onChange={(event) => setTranscriptText(event.target.value)} placeholder={'Representative: What products are customers asking for?\nShopkeeper: They ask for the small pack.\nRepresentative: I will check availability and call tomorrow.'}/></label>
      <label className="transcript-consent"><input type="checkbox" checked={consentConfirmed} onChange={(event) => setConsentConfirmed(event.target.checked)}/><span>I confirm I have permission to analyze this conversation transcript.</span></label>
      {status && <p className={`transcript-form-status ${status.kind}`} role={status.kind === 'error' ? 'alert' : 'status'} aria-live={status.kind === 'error' ? 'assertive' : 'polite'}>{status.message}</p>}
      <div className="transcript-import-actions"><span>Speaker labels such as “Representative:” and “Shopkeeper:” improve attribution. Add the conversation date to resolve relative follow-up timing; findings cite source lines.</span><button className="button" type="submit" disabled={busy || !consentConfirmed || !transcriptText.trim()}>{busy ? 'Analyzing transcript…' : 'Ingest and analyze'}</button></div>
    </form>
  </section>;
}
