import type {
  AnalysisState,
  RecordingMetadata,
  SyncState
} from '@itc/domain';

export interface VisitRecord {
  id: string;
  outletName: string;
  representativeId: string;
  territoryId: string;
  consentRecordedAt: string;
  createdAt: string;
  recordingIds: string[];
}

export interface CreateVisitInput {
  id: string;
  outletName: string;
  representativeId: string;
  territoryId: string;
  consentRecordedAt: string;
}

export interface CreateRecordingInput {
  id: string;
  startedAt: string;
  durationSeconds: number;
  mimeType: string;
  byteLength: number;
}

export interface RecordingFilters {
  syncState?: SyncState;
  analysisState?: AnalysisState;
  representativeId?: string;
  territoryId?: string;
  limit: number;
  offset: number;
}

export type CreateResult<T> =
  | { kind: 'created'; value: T }
  | { kind: 'existing'; value: T }
  | { kind: 'conflict' };

export type CreateRecordingResult<T> = CreateResult<T> | { kind: 'parent_not_found' };

export interface RecordingPage {
  recordings: RecordingMetadata[];
  total: number;
  nextOffset: number | null;
}

export interface RecordingRepository {
  createVisit(input: CreateVisitInput): CreateResult<VisitRecord>;
  getVisit(id: string): VisitRecord | undefined;
  createRecording(visitId: string, input: CreateRecordingInput): CreateRecordingResult<RecordingMetadata>;
  getRecording(id: string): RecordingMetadata | undefined;
  getRecordingVisitId(id: string): string | undefined;
  getAnalysisStatus(id: string): Pick<RecordingMetadata, 'id' | 'syncState' | 'analysisState'> | undefined;
  listRecordings(filters: RecordingFilters): RecordingPage;
  transitionSyncState(id: string, next: SyncState, objectKey?: string): boolean;
  transitionAnalysisState(id: string, next: AnalysisState): boolean;
}

function visitInputMatches(visit: VisitRecord, input: CreateVisitInput): boolean {
  return visit.outletName === input.outletName
    && visit.representativeId === input.representativeId
    && visit.territoryId === input.territoryId
    && visit.consentRecordedAt === input.consentRecordedAt;
}

function recordingInputMatches(recording: RecordingMetadata, input: CreateRecordingInput): boolean {
  return recording.startedAt === input.startedAt
    && recording.durationSeconds === input.durationSeconds
    && recording.mimeType === input.mimeType
    && recording.byteLength === input.byteLength;
}

const allowedSyncTransitions: Record<SyncState, readonly SyncState[]> = {
  queued: ['uploading', 'error'],
  uploading: ['uploaded', 'error'],
  uploaded: [],
  error: ['queued']
};

const allowedAnalysisTransitions: Record<AnalysisState, readonly AnalysisState[]> = {
  not_started: ['transcribing'],
  transcribing: ['analyzing', 'error'],
  analyzing: ['ready', 'error'],
  ready: [],
  error: ['transcribing']
};

/**
 * Volatile in-memory adapter for local demo flows only. Replace this with a
 * durable repository before treating API state as production data.
 */
export class DemoRecordingRepository implements RecordingRepository {
  private readonly visits = new Map<string, VisitRecord>();
  private readonly recordings = new Map<string, RecordingMetadata>();
  private readonly visitByRecordingId = new Map<string, string>();

  createVisit(input: CreateVisitInput): CreateResult<VisitRecord> {
    const existing = this.visits.get(input.id);
    if (existing) {
      return visitInputMatches(existing, input)
        ? { kind: 'existing', value: existing }
        : { kind: 'conflict' };
    }

    const visit: VisitRecord = {
      ...input,
      createdAt: new Date().toISOString(),
      recordingIds: []
    };
    this.visits.set(visit.id, visit);
    return { kind: 'created', value: visit };
  }

  getVisit(id: string): VisitRecord | undefined {
    return this.visits.get(id);
  }

  createRecording(visitId: string, input: CreateRecordingInput): CreateRecordingResult<RecordingMetadata> {
    const visit = this.visits.get(visitId);
    if (!visit) return { kind: 'parent_not_found' };

    const existing = this.recordings.get(input.id);
    if (existing) {
      const existingVisitId = this.visitByRecordingId.get(input.id);
      return existingVisitId === visitId && recordingInputMatches(existing, input)
        ? { kind: 'existing', value: existing }
        : { kind: 'conflict' };
    }

    const recording: RecordingMetadata = {
      id: input.id,
      outletId: undefined,
      outletName: visit.outletName,
      representativeId: visit.representativeId,
      territoryId: visit.territoryId,
      startedAt: input.startedAt,
      durationSeconds: input.durationSeconds,
      mimeType: input.mimeType,
      byteLength: input.byteLength,
      syncState: 'queued',
      analysisState: 'not_started'
    };

    visit.recordingIds.push(recording.id);
    this.recordings.set(recording.id, recording);
    this.visitByRecordingId.set(recording.id, visit.id);
    return { kind: 'created', value: recording };
  }

  getRecording(id: string): RecordingMetadata | undefined {
    return this.recordings.get(id);
  }

  getRecordingVisitId(id: string): string | undefined {
    return this.visitByRecordingId.get(id);
  }

  getAnalysisStatus(id: string): Pick<RecordingMetadata, 'id' | 'syncState' | 'analysisState'> | undefined {
    const recording = this.recordings.get(id);
    if (!recording) return undefined;
    return {
      id: recording.id,
      syncState: recording.syncState,
      analysisState: recording.analysisState
    };
  }

  listRecordings(filters: RecordingFilters): RecordingPage {
    const matching = Array.from(this.recordings.values())
      .filter((recording) => !filters.syncState || recording.syncState === filters.syncState)
      .filter((recording) => !filters.analysisState || recording.analysisState === filters.analysisState)
      .filter((recording) => !filters.representativeId || recording.representativeId === filters.representativeId)
      .filter((recording) => !filters.territoryId || recording.territoryId === filters.territoryId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));

    const recordings = matching.slice(filters.offset, filters.offset + filters.limit);
    const next = filters.offset + recordings.length;
    return {
      recordings,
      total: matching.length,
      nextOffset: next < matching.length ? next : null
    };
  }

  transitionSyncState(id: string, next: SyncState, objectKey?: string): boolean {
    const recording = this.recordings.get(id);
    if (!recording || !allowedSyncTransitions[recording.syncState].includes(next)) return false;
    recording.syncState = next;
    if (objectKey) recording.objectKey = objectKey;
    if (next === 'uploaded') recording.analysisState = 'not_started';
    return true;
  }

  transitionAnalysisState(id: string, next: AnalysisState): boolean {
    const recording = this.recordings.get(id);
    if (!recording || !allowedAnalysisTransitions[recording.analysisState].includes(next)) return false;
    recording.analysisState = next;
    return true;
  }
}
