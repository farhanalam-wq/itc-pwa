export type SyncState = 'queued' | 'uploading' | 'uploaded' | 'error';
export type AnalysisState = 'not_started' | 'transcribing' | 'analyzing' | 'ready' | 'error';
export type VisitOutcome = 'order_placed' | 'follow_up' | 'no_order' | 'new_outlet' | 'not_stated';
export type Confidence = 'high' | 'medium' | 'low';
export type SentimentCue = 'positive' | 'neutral' | 'hesitant' | 'at_risk' | 'unknown';
export type InsightExplicitness = 'explicit' | 'inferred' | 'uncertain';
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
  outletName: string;
  representativeId: string;
  territoryId: string;
  startedAt: string;
  durationSeconds: number;
  mimeType: string;
  byteLength: number;
  objectKey?: string;
  syncState: SyncState;
  analysisState: AnalysisState;
}

export interface TranscriptSegment {
  id: string;
  speaker: 'representative' | 'shopkeeper' | 'unknown';
  /** Text imports do not carry timing; absent timing means it was not provided. */
  startMs?: number;
  endMs?: number;
  text: string;
  confidence?: number;
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
