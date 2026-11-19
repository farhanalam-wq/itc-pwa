import type { Db, Document } from 'mongodb';
import type { AnalysisState, RecordingMetadata, SyncState } from '@itc/domain';
import type {
  CreateRecordingInput,
  CreateRecordingResult,
  CreateResult,
  RecordingFilters,
  RecordingPage,
  RecordingRepository,
  StoredObjectMetadata,
  VisitRecord,
  CreateVisitInput
} from './demo-repository';

interface VisitDocument extends VisitRecord, Document {}
interface RecordingDocument extends RecordingMetadata, Document {
  visitId: string;
  sha256?: string;
  storageDriver?: 'local' | 's3';
}

function duplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

function visitMatches(existing: VisitRecord, input: CreateVisitInput): boolean {
  return existing.outletName === input.outletName
    && existing.representativeId === input.representativeId
    && existing.territoryId === input.territoryId
    && existing.consentRecordedAt === input.consentRecordedAt;
}

function recordingMatches(existing: RecordingMetadata, input: CreateRecordingInput): boolean {
  return existing.startedAt === input.startedAt
    && existing.durationSeconds === input.durationSeconds
    && existing.mimeType === input.mimeType
    && existing.byteLength === input.byteLength;
}

function visitValue(document: VisitDocument): VisitRecord {
  const { _id: _ignored, ...visit } = document;
  return visit;
}

function recordingValue(document: RecordingDocument): RecordingMetadata {
  const { _id: _ignored, visitId: _visitId, ...recording } = document;
  return recording;
}

/** Durable adapter. Collections are initialized once during API startup. */
export class MongoRecordingRepository implements RecordingRepository {
  private readonly visits;
  private readonly recordings;

  constructor(database: Db) {
    this.visits = database.collection<VisitDocument>('visits');
    this.recordings = database.collection<RecordingDocument>('recordings');
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.visits.createIndex({ id: 1 }, { unique: true, name: 'visit_id_unique' }),
      this.recordings.createIndex({ id: 1 }, { unique: true, name: 'recording_id_unique' }),
      this.recordings.createIndex({ visitId: 1, startedAt: -1 }, { name: 'recording_visit_history' }),
      this.recordings.createIndex({ syncState: 1, startedAt: -1 }, { name: 'recording_sync_queue' }),
      this.recordings.createIndex({ analysisState: 1, startedAt: -1 }, { name: 'recording_transcription_queue' })
    ]);
  }

  async createVisit(input: CreateVisitInput): Promise<CreateResult<VisitRecord>> {
    const existing = await this.visits.findOne({ id: input.id });
    if (existing) {
      const value = visitValue(existing);
      return visitMatches(value, input) ? { kind: 'existing', value } : { kind: 'conflict' };
    }

    const value: VisitRecord = { ...input, createdAt: new Date().toISOString(), recordingIds: [] };
    try {
      await this.visits.insertOne(value);
      return { kind: 'created', value };
    } catch (error) {
      if (!duplicateKey(error)) throw error;
      const raced = await this.visits.findOne({ id: input.id });
      if (!raced) throw error;
      const racedValue = visitValue(raced);
      return visitMatches(racedValue, input) ? { kind: 'existing', value: racedValue } : { kind: 'conflict' };
    }
  }

  async getVisit(id: string): Promise<VisitRecord | undefined> {
    const found = await this.visits.findOne({ id });
    return found ? visitValue(found) : undefined;
  }

  async createRecording(visitId: string, input: CreateRecordingInput): Promise<CreateRecordingResult<RecordingMetadata>> {
    const visitDocument = await this.visits.findOne({ id: visitId });
    if (!visitDocument) return { kind: 'parent_not_found' };
    const visit = visitValue(visitDocument);

    const existing = await this.recordings.findOne({ id: input.id });
    if (existing) {
      const value = recordingValue(existing);
      return existing.visitId === visitId && recordingMatches(value, input)
        ? { kind: 'existing', value }
        : { kind: 'conflict' };
    }

    const value: RecordingMetadata = {
      id: input.id,
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

    try {
      await this.recordings.insertOne({ ...value, visitId });
      await this.visits.updateOne({ id: visitId }, { $addToSet: { recordingIds: value.id } });
      return { kind: 'created', value };
    } catch (error) {
      if (!duplicateKey(error)) throw error;
      const raced = await this.recordings.findOne({ id: input.id });
      if (!raced) throw error;
      const racedValue = recordingValue(raced);
      return raced.visitId === visitId && recordingMatches(racedValue, input)
        ? { kind: 'existing', value: racedValue }
        : { kind: 'conflict' };
    }
  }

  async getRecording(id: string): Promise<RecordingMetadata | undefined> {
    const found = await this.recordings.findOne({ id });
    return found ? recordingValue(found) : undefined;
  }

  async getRecordingVisitId(id: string): Promise<string | undefined> {
    const found = await this.recordings.findOne({ id }, { projection: { visitId: 1 } });
    return found?.visitId;
  }

  async getAnalysisStatus(id: string): Promise<Pick<RecordingMetadata, 'id' | 'syncState' | 'analysisState'> | undefined> {
    const found = await this.recordings.findOne({ id }, { projection: { id: 1, syncState: 1, analysisState: 1 } });
    if (!found) return undefined;
    return { id: found.id, syncState: found.syncState, analysisState: found.analysisState };
  }

  async listRecordings(filters: RecordingFilters): Promise<RecordingPage> {
    const query: Document = {};
    if (filters.syncState) query.syncState = filters.syncState;
    if (filters.analysisState) query.analysisState = filters.analysisState;
    if (filters.representativeId) query.representativeId = filters.representativeId;
    if (filters.territoryId) query.territoryId = filters.territoryId;

    const [documents, total] = await Promise.all([
      this.recordings.find(query).sort({ startedAt: -1 }).skip(filters.offset).limit(filters.limit).toArray(),
      this.recordings.countDocuments(query)
    ]);
    const recordings = documents.map(recordingValue);
    const next = filters.offset + recordings.length;
    return { recordings, total, nextOffset: next < total ? next : null };
  }

  async transitionSyncState(id: string, next: SyncState, objectKey?: string): Promise<boolean> {
    const allowedFrom: Record<SyncState, SyncState[]> = {
      queued: ['error'],
      uploading: ['queued'],
      uploaded: ['uploading'],
      error: ['queued', 'uploading']
    };
    const filter: Document = { id, syncState: { $in: allowedFrom[next] } };
    const update: Document = { syncState: next };
    if (objectKey) update.objectKey = objectKey;
    if (next === 'uploaded') update.analysisState = 'not_started';
    const result = await this.recordings.updateOne(filter, { $set: update });
    return result.modifiedCount === 1;
  }

  async attachStoredObject(id: string, stored: StoredObjectMetadata): Promise<boolean> {
    const result = await this.recordings.updateOne(
      { id, byteLength: stored.byteLength, mimeType: stored.mimeType },
      {
        $set: {
          storageDriver: stored.driver,
          objectKey: stored.objectKey,
          byteLength: stored.byteLength,
          mimeType: stored.mimeType,
          sha256: stored.sha256
        }
      }
    );
    return result.matchedCount === 1;
  }

  async transitionAnalysisState(id: string, next: AnalysisState): Promise<boolean> {
    const allowedFrom: Record<AnalysisState, AnalysisState[]> = {
      not_started: [],
      transcribing: ['not_started', 'error'],
      analyzing: ['transcribing'],
      ready: ['analyzing', 'transcribing'],
      error: ['transcribing', 'analyzing']
    };
    const result = await this.recordings.updateOne(
      { id, analysisState: { $in: allowedFrom[next] } },
      { $set: { analysisState: next } }
    );
    return result.modifiedCount === 1;
  }
}

export async function createMongoRecordingRepository(database: Db): Promise<MongoRecordingRepository> {
  const repository = new MongoRecordingRepository(database);
  await repository.initialize();
  return repository;
}
