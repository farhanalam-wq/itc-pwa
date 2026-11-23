import type { Db, Document } from 'mongodb';
import type { AnalysisState, RecordingMetadata } from '@itc/domain';
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
  const existingAudio = existing.denoisedAnalysisAudio;
  const incomingAudio = input.denoisedAnalysisAudio;
  const inputAudioMatches = !existingAudio && !incomingAudio
    || Boolean(existingAudio && incomingAudio
      && existingAudio.state === incomingAudio.state
      && existingAudio.mimeType === incomingAudio.mimeType
      && existingAudio.byteLength === incomingAudio.byteLength
      && (incomingAudio.sha256 === undefined || existingAudio.sha256 === incomingAudio.sha256)
      && existingAudio.sampleRateHz === incomingAudio.sampleRateHz
      && existingAudio.durationSeconds === incomingAudio.durationSeconds
      && existingAudio.model === incomingAudio.model
      && existingAudio.modelVersion === incomingAudio.modelVersion
      && existingAudio.errorCode === incomingAudio.errorCode);
  return existing.startedAt === input.startedAt
    && existing.durationSeconds === input.durationSeconds
    && existing.mimeType === input.mimeType
    && existing.byteLength === input.byteLength
    && inputAudioMatches;
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
  private readonly pendingUploads;

  constructor(database: Db) {
    this.visits = database.collection<VisitDocument>('visits');
    this.recordings = database.collection<RecordingDocument>('recordings');
    this.pendingUploads = database.collection<RecordingDocument>('pending_recording_uploads');
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.visits.createIndex({ id: 1 }, { unique: true, name: 'visit_id_unique' }),
      this.pendingUploads.createIndex({ id: 1 }, { unique: true, name: 'pending_recording_id_unique' }),
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
      await this.visits.insertOne(value, { ignoreUndefined: true });
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
    if (!found) return undefined;
    const recordings = await this.recordings.find({ visitId: id, syncState: 'uploaded' }, { projection: { id: 1 } }).toArray();
    return { ...visitValue(found), recordingIds: recordings.map((recording) => recording.id) };
  }

  async createRecording(visitId: string, input: CreateRecordingInput): Promise<CreateRecordingResult<RecordingMetadata>> {
    const visitDocument = await this.visits.findOne({ id: visitId });
    if (!visitDocument) return { kind: 'parent_not_found' };
    const visit = visitValue(visitDocument);

    const existing = await this.findUpload(input.id);
    if (existing) {
      const value = recordingValue(existing);
      return existing.visitId === visitId && recordingMatches(value, input)
        ? { kind: 'existing', value }
        : { kind: 'conflict' };
    }

    const value: RecordingMetadata = {
      id: input.id,
      ...(visit.outletName === undefined ? {} : { outletName: visit.outletName }),
      ...(visit.representativeId === undefined ? {} : { representativeId: visit.representativeId }),
      ...(visit.territoryId === undefined ? {} : { territoryId: visit.territoryId }),
      startedAt: input.startedAt,
      durationSeconds: input.durationSeconds,
      mimeType: input.mimeType,
      byteLength: input.byteLength,
      syncState: 'queued',
      analysisState: 'not_started',
      conversationAnalysisState: input.denoisedAnalysisAudio && input.denoisedAnalysisAudio.state !== 'ready' ? 'failed' : 'not_started',
      ...(input.denoisedAnalysisAudio ? {
        denoisedAnalysisAudio: {
          ...input.denoisedAnalysisAudio,
          syncState: input.denoisedAnalysisAudio.state === 'ready' ? 'queued' as const : 'error' as const
        }
      } : {})
    };

    try {
      await this.pendingUploads.insertOne({ ...value, visitId });
      return { kind: 'created', value };
    } catch (error) {
      if (!duplicateKey(error)) throw error;
      const raced = await this.findUpload(input.id);
      if (!raced) throw error;
      const racedValue = recordingValue(raced);
      return raced.visitId === visitId && recordingMatches(racedValue, input)
        ? { kind: 'existing', value: racedValue }
        : { kind: 'conflict' };
    }
  }

  private async findUpload(id: string) {
    // Promotion inserts the completed record before removing its pending entry.
    const pending = await this.pendingUploads.findOne({ id });
    return await this.recordings.findOne({ id }) ?? pending;
  }

  async getUploadRecording(id: string): Promise<RecordingMetadata | undefined> {
    const found = await this.findUpload(id);
    return found ? recordingValue(found) : undefined;
  }

  async getRecording(id: string): Promise<RecordingMetadata | undefined> {
    const found = await this.recordings.findOne({ id, syncState: 'uploaded' });
    return found ? recordingValue(found) : undefined;
  }

  async deleteRecording(id: string): Promise<void> {
    await this.pendingUploads.deleteOne({ id });
    await this.recordings.deleteOne({ id, syncState: 'uploaded' });
  }

  async getRecordingVisitId(id: string): Promise<string | undefined> {
    const found = await this.recordings.findOne({ id, syncState: 'uploaded' }, { projection: { visitId: 1 } });
    return found?.visitId;
  }

  async getAnalysisStatus(id: string): Promise<Pick<RecordingMetadata, 'id' | 'syncState' | 'analysisState' | 'conversationAnalysisState'> | undefined> {
    const found = await this.recordings.findOne({ id, syncState: 'uploaded' }, { projection: { id: 1, syncState: 1, analysisState: 1, conversationAnalysisState: 1 } });
    if (!found) return undefined;
    return { id: found.id, syncState: found.syncState, analysisState: found.analysisState, conversationAnalysisState: found.conversationAnalysisState };
  }

  async listRecordings(filters: RecordingFilters): Promise<RecordingPage> {
    if (filters.syncState && filters.syncState !== 'uploaded') return { recordings: [], total: 0, nextOffset: null };
    const query: Document = { syncState: 'uploaded' };
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

  async completeRecording(id: string, stored: StoredObjectMetadata): Promise<RecordingMetadata | undefined> {
    const upload = await this.findUpload(id);
    if (!upload || upload.byteLength !== stored.byteLength || upload.mimeType !== stored.mimeType) return undefined;
    const completed = {
      ...recordingValue(upload),
      visitId: upload.visitId,
      syncState: 'uploaded' as const,
      analysisState: 'not_started' as const,
      storageDriver: stored.driver,
      objectKey: stored.objectKey,
      sha256: stored.sha256
    };

    // Also promotes pending records created by versions that used a single collection.
    try {
      await this.recordings.updateOne(
        { id, syncState: { $ne: 'uploaded' } },
        { $set: completed },
        { upsert: true }
      );
    } catch (error) {
      if (!duplicateKey(error)) throw error;
    }
    const saved = await this.getRecording(id);
    if (!saved || saved.sha256 !== stored.sha256 || saved.storageDriver !== stored.driver || saved.objectKey !== stored.objectKey) return undefined;
    await this.pendingUploads.deleteOne({ id }).catch(() => undefined);
    return saved;
  }

  async completeDenoisedAnalysisAudio(id: string, stored: StoredObjectMetadata): Promise<RecordingMetadata | undefined> {
    const query: Document = {
      id,
      syncState: 'uploaded',
      'denoisedAnalysisAudio.state': 'ready',
      'denoisedAnalysisAudio.byteLength': stored.byteLength,
      'denoisedAnalysisAudio.mimeType': stored.mimeType
    };
    const existingAudio = await this.recordings.findOne({ id }, { projection: { denoisedAnalysisAudio: 1 } });
    if (existingAudio?.denoisedAnalysisAudio?.sha256) query['denoisedAnalysisAudio.sha256'] = stored.sha256;
    const found = await this.recordings.findOne(query);
    if (!found || !found.denoisedAnalysisAudio) return undefined;
    const denoisedAnalysisAudio = {
      ...found.denoisedAnalysisAudio,
      syncState: 'uploaded' as const,
      objectKey: stored.objectKey,
      byteLength: stored.byteLength,
      mimeType: stored.mimeType,
      sha256: stored.sha256
    };
    const updateQuery: Document = {
      id,
      syncState: 'uploaded',
      'denoisedAnalysisAudio.state': 'ready',
      'denoisedAnalysisAudio.byteLength': stored.byteLength,
      'denoisedAnalysisAudio.mimeType': stored.mimeType
    };
    if (existingAudio?.denoisedAnalysisAudio?.sha256) updateQuery['denoisedAnalysisAudio.sha256'] = stored.sha256;
    const updated = await this.recordings.updateOne(updateQuery, { $set: { denoisedAnalysisAudio } });
    if (updated.matchedCount !== 1) return undefined;
    const saved = await this.getRecording(id);
    const savedAudio = saved?.denoisedAnalysisAudio;
    if (!savedAudio || savedAudio.objectKey !== stored.objectKey || savedAudio.sha256 !== stored.sha256
      || savedAudio.byteLength !== stored.byteLength || savedAudio.mimeType !== stored.mimeType
      || savedAudio.syncState !== 'uploaded') return undefined;
    return saved;
  }

  async findRecordingsWithoutTranscription(limit = 100): Promise<string[]> {
    const missing = await this.recordings.aggregate<{ id: string }>([
      { $match: {
        syncState: 'uploaded',
        'denoisedAnalysisAudio.state': 'ready',
        'denoisedAnalysisAudio.sampleRateHz': 48000,
        'denoisedAnalysisAudio.durationSeconds': { $gt: 0 },
        'denoisedAnalysisAudio.syncState': 'uploaded',
        'denoisedAnalysisAudio.objectKey': { $type: 'string' },
        'denoisedAnalysisAudio.sha256': { $type: 'string' }
      } },
      { $lookup: { from: 'transcription_jobs', localField: 'id', foreignField: 'recordingId', as: 'jobs' } },
      { $match: { 'jobs.0': { $exists: false } } },
      { $limit: limit },
      { $project: { _id: 0, id: 1 } }
    ]).toArray();
    return missing.map(({ id }) => id);
  }

  async transitionAnalysisState(id: string, next: AnalysisState): Promise<boolean> {
    const allowedFrom: Record<AnalysisState, AnalysisState[]> = {
      not_started: [],
      transcribing: ['not_started', 'error', 'ready'],
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

  async transitionConversationAnalysisState(
    id: string,
    next: RecordingMetadata['conversationAnalysisState'] & string
  ): Promise<boolean> {
    const result = await this.recordings.updateOne({ id, syncState: 'uploaded' }, {
      $set: { conversationAnalysisState: next }
    });
    return result.modifiedCount === 1;
  }
}

export async function createMongoRecordingRepository(database: Db): Promise<MongoRecordingRepository> {
  const repository = new MongoRecordingRepository(database);
  await repository.initialize();
  return repository;
}
