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

export interface StoredObjectMetadata {
  driver: 'local' | 's3';
  objectKey: string;
  byteLength: number;
  mimeType: string;
  sha256: string;
}

export interface RecordingRepository {
  createVisit(input: CreateVisitInput): Promise<CreateResult<VisitRecord>>;
  getVisit(id: string): Promise<VisitRecord | undefined>;
  createRecording(visitId: string, input: CreateRecordingInput): Promise<CreateRecordingResult<RecordingMetadata>>;
  getUploadRecording(id: string): Promise<RecordingMetadata | undefined>;
  getRecording(id: string): Promise<RecordingMetadata | undefined>;
  getRecordingVisitId(id: string): Promise<string | undefined>;
  getAnalysisStatus(id: string): Promise<Pick<RecordingMetadata, 'id' | 'syncState' | 'analysisState'> | undefined>;
  listRecordings(filters: RecordingFilters): Promise<RecordingPage>;
  completeRecording(id: string, stored: StoredObjectMetadata): Promise<RecordingMetadata | undefined>;
  transitionAnalysisState(id: string, next: AnalysisState): Promise<boolean>;
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

const allowedAnalysisTransitions: Record<AnalysisState, readonly AnalysisState[]> = {
  not_started: ['transcribing'],
  transcribing: ['analyzing', 'ready', 'error'],
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

  async createVisit(input: CreateVisitInput): Promise<CreateResult<VisitRecord>> {
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

  async getVisit(id: string): Promise<VisitRecord | undefined> {
    return this.visits.get(id);
  }

  async createRecording(visitId: string, input: CreateRecordingInput): Promise<CreateRecordingResult<RecordingMetadata>> {
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

    this.recordings.set(recording.id, recording);
    this.visitByRecordingId.set(recording.id, visit.id);
    return { kind: 'created', value: recording };
  }

  async getUploadRecording(id: string): Promise<RecordingMetadata | undefined> {
    return this.recordings.get(id);
  }

  async getRecording(id: string): Promise<RecordingMetadata | undefined> {
    const recording = await this.getUploadRecording(id);
    return recording?.syncState === 'uploaded' ? recording : undefined;
  }

  async getRecordingVisitId(id: string): Promise<string | undefined> {
    return await this.getRecording(id) ? this.visitByRecordingId.get(id) : undefined;
  }

  async getAnalysisStatus(id: string): Promise<Pick<RecordingMetadata, 'id' | 'syncState' | 'analysisState'> | undefined> {
    const recording = await this.getRecording(id);
    if (!recording) return undefined;
    return {
      id: recording.id,
      syncState: recording.syncState,
      analysisState: recording.analysisState
    };
  }

  async listRecordings(filters: RecordingFilters): Promise<RecordingPage> {
    const matching = Array.from(this.recordings.values())
      .filter((recording) => recording.syncState === 'uploaded')
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

  async completeRecording(id: string, stored: StoredObjectMetadata): Promise<RecordingMetadata | undefined> {
    const recording = this.recordings.get(id);
    if (!recording || recording.byteLength !== stored.byteLength || recording.mimeType !== stored.mimeType) return undefined;
    if (recording.syncState === 'uploaded') return recording.sha256 === stored.sha256 ? recording : undefined;
    recording.objectKey = stored.objectKey;
    recording.storageDriver = stored.driver;
    recording.sha256 = stored.sha256;
    recording.syncState = 'uploaded';
    const visitId = this.visitByRecordingId.get(id);
    if (visitId) this.visits.get(visitId)?.recordingIds.push(id);
    return recording;
  }

  async transitionAnalysisState(id: string, next: AnalysisState): Promise<boolean> {
    const recording = this.recordings.get(id);
    if (!recording || !allowedAnalysisTransitions[recording.analysisState].includes(next)) return false;
    recording.analysisState = next;
    return true;
  }
}
