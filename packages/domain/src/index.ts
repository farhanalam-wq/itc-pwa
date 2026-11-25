export type SyncState = 'queued' | 'uploading' | 'uploaded' | 'error';
export type StorageDriver = 'local' | 's3';
export type AnalysisState = 'not_started' | 'transcribing' | 'analyzing' | 'ready' | 'error';
export type TranscriptionJobState = 'not_started' | 'queued' | 'processing' | 'completed' | 'failed';
export type VisitOutcome = 'order_placed' | 'follow_up' | 'no_order' | 'new_outlet' | 'not_stated';
export type Confidence = 'high' | 'medium' | 'low';
export type SentimentCue = 'positive' | 'neutral' | 'hesitant' | 'at_risk' | 'unknown';
export type InsightExplicitness = 'explicit' | 'inferred' | 'uncertain';
export type DenoisingState = 'not_started' | 'initializing' | 'processing' | 'ready' | 'failed' | 'unsupported' | 'incomplete';
export type ConversationAnalysisState = 'not_started' | 'queued' | 'processing' | 'completed' | 'failed';
export const MAX_TRANSCRIBABLE_RECORDING_SECONDS = 600;
export type InsightCategory =
  | 'demand'
  | 'objection'
  | 'availability'
  | 'competitor'
  | 'sentiment'
  | 'commitment'
  | 'conversation_quality';

export interface RecordingMetadata {
  id: string;
  outletId?: string;
  outletName?: string;
  representativeId?: string;
  territoryId?: string;
  startedAt: string;
  durationSeconds: number;
  mimeType: string;
  byteLength: number;
  objectKey?: string;
  storageDriver?: StorageDriver;
  sha256?: string;
  syncState: SyncState;
  analysisState: AnalysisState;
  /** The denoised copy is an analysis artifact; the recording fields above always describe the original capture. */
  denoisedAnalysisAudio?: DenoisedAnalysisAudio;
  conversationAnalysisState?: ConversationAnalysisState;
}

/** Metadata for the separately stored DeepFilterNet copy that is eligible for Pyannote. */
export interface DenoisedAnalysisAudio {
  state: DenoisingState;
  syncState?: SyncState;
  objectKey?: string;
  mimeType?: string;
  byteLength?: number;
  sha256?: string;
  sampleRateHz?: number;
  durationSeconds?: number;
  model?: string;
  modelVersion?: string;
  errorCode?: string;
}

export type DenoisedAnalysisAudioInput = Pick<DenoisedAnalysisAudio,
  'state' | 'mimeType' | 'byteLength' | 'sha256' | 'sampleRateHz' | 'durationSeconds' | 'model' | 'modelVersion' | 'errorCode'>;

export interface TranscriptSegment {
  id: string;
  speaker: 'representative' | 'shopkeeper' | 'unknown';
  /** Text imports do not carry timing; absent timing means it was not provided. */
  startMs?: number;
  endMs?: number;
  text: string;
  confidence?: number;
}

/** Plain transcript from audio transcription; timing and speaker data are omitted unless supplied. */
export interface RecordingTranscriptTurn {
  id: string;
  speaker: string;
  startMs: number;
  endMs: number;
  text: string;
  overlapsSpeech: boolean;
}

export interface RecordingTranscript {
  recordingId: string;
  state: TranscriptionJobState;
  provider: 'openai';
  model: string;
  transcriptText?: string;
  turns?: RecordingTranscriptTurn[];
  diarizer?: { model: string; revision?: string };
  stage?: 'diarizing' | 'transcribing';
  canReprocess?: boolean;
  languageCodes?: string[];
  attempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  retryable?: boolean;
}

export interface InsightEvidence {
  segmentIds: string[];
  quote: string;
  startMs?: number;
  endMs?: number;
}

export interface ConversationInsight {
  id: string;
  category: InsightCategory;
  title: string;
  summary: string;
  confidence: Confidence;
  evidence: InsightEvidence[];
  suggestedAction?: string;
  reviewedAt?: string;
  reviewedBy?: string;
}

export interface ManualTranscriptInsight extends ConversationInsight {
  taxonomyKey: string;
  mentionCount: number;
  explicitness: InsightExplicitness;
}

export interface ManualTranscriptCoachingSignal {
  rubricKey: 'discovery' | 'benefit_explanation' | 'objection_response' | 'close_or_next_step';
  label: string;
  confidence: Confidence;
  evidenceSegmentIds: string[];
  note: string;
}

export type OrderIntent = 'confirmed' | 'conditional' | 'considering' | 'declined' | 'unknown';

/** One explicitly confirmed or qualified purchase intent, linked to diarized transcript evidence. */
export interface ConversationOrderSignal {
  id: string;
  intent: OrderIntent;
  productName?: string;
  brand?: string;
  packDescription?: string;
  quantity?: number;
  quantityUnit?: string;
  unitPriceInr?: number;
  totalValueInr?: number;
  confidence: Confidence;
  evidence: InsightEvidence[];
}

/** Sales-relevant signal from a real diarized recording, distinct from manual-import/demo reports. */
export interface ConversationSalesSignal extends ConversationInsight {
  taxonomyKey: string;
  explicitness: InsightExplicitness;
  mentionCount: number;
  /** Structured, transcript-grounded fields used for filters and aggregate metrics. */
  productName?: string;
  brand?: string;
  packDescription?: string;
  explicitCount?: number;
  countUnit?: string;
  status?: 'reported' | 'conditional' | 'unverified' | 'resolved' | 'unknown';
}

/** Production sales analysis produced only after a real recording has a completed diarized transcript. */
export interface RecordingConversationAnalysis {
  recordingId: string;
  state: ConversationAnalysisState;
  provider: 'openai';
  model: string;
  analysisVersion: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  outcome: VisitOutcome;
  outcomeConfidence: Confidence;
  outcomeExplicitness: InsightExplicitness;
  outcomeEvidence: InsightEvidence[];
  summary?: string;
  confirmedOrders: ConversationOrderSignal[];
  salesSignals: ConversationSalesSignal[];
  sentimentCue: SentimentCue;
  sentimentConfidence: Confidence;
  nextAction?: string;
  nextActionDue?: string;
  nextActionEvidence: InsightEvidence[];
  coachingSignals: ManualTranscriptCoachingSignal[];
  errorCode?: string;
  errorMessage?: string;
  retryable?: boolean;
}

export interface ConversationAnalysisSignalMetric {
  taxonomyKey: string;
  category: InsightCategory;
  mentionCount: number;
  recordingCount: number;
  outletCount: number;
  confidenceCounts: Record<Confidence, number>;
  explicitnessCounts: Record<InsightExplicitness, number>;
}

export interface ConversationAnalysisReport {
  generatedAt: string;
  filters: {
    from?: string;
    to?: string;
    territoryId?: string;
    representativeId?: string;
  };
  captureCount: number;
  analyzedRecordingCount: number;
  pendingRecordingCount: number;
  failedRecordingCount: number;
  outcomeCounts: Record<VisitOutcome, number>;
  confirmedOrderCount: number;
  confirmedOrdersWithValueCount: number;
  confirmedOrderValueInr: number;
  signals: ConversationAnalysisSignalMetric[];
  followUps: {
    actionCount: number;
    datedActionCount: number;
    overdueActionCount: number;
  };
  evidenceCoverage: {
    findingCount: number;
    evidenceLinkedFindingCount: number;
    highConfidenceFindingCount: number;
    mediumConfidenceFindingCount: number;
    lowConfidenceFindingCount: number;
    uncertainFindingCount: number;
  };
  territories: Array<{ id: string; name?: string; recordingCount: number; analyzedRecordingCount: number }>;
  representatives: Array<{ id: string; name?: string; recordingCount: number; analyzedRecordingCount: number }>;
}

/** A deterministic report derived from user-supplied transcript text. */
export interface ManualTranscriptAnalysis {
  source: 'manual_transcript';
  id: string;
  createdAt: string;
  /** Supplied source date for the conversation; never inferred from import time. */
  conversationDate?: string;
  fileName: string;
  rawTranscript: string;
  storageState: 's3' | 'in-memory-demo';
  objectKey?: string;
  durationSeconds?: number;
  representativeId: string;
  representativeName?: string;
  representativeInitials?: string;
  territoryId: string;
  territoryName?: string;
  city?: string;
  outletId?: string;
  outletName: string;
  outcome: VisitOutcome;
  outcomeEvidenceSegmentIds: string[];
  /** Only present when a confirmed order and explicit order total are both stated. */
  confirmedOrderValueInr?: number;
  sentimentCue: SentimentCue;
  sentimentConfidence: Confidence;
  summary: string;
  nextAction?: string;
  nextActionEvidenceSegmentIds?: string[];
  nextActionDue?: string;
  productsDiscussed: string[];
  transcript: TranscriptSegment[];
  insights: ManualTranscriptInsight[];
  coachingSignals: ManualTranscriptCoachingSignal[];
}
