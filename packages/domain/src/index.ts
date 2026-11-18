export type SyncState = 'queued' | 'uploading' | 'uploaded' | 'error';
export type AnalysisState = 'not_started' | 'transcribing' | 'analyzing' | 'ready' | 'error';
export type VisitOutcome = 'order_placed' | 'follow_up' | 'no_order' | 'new_outlet';
export type Confidence = 'high' | 'medium' | 'low';
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
  startMs: number;
  endMs: number;
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
