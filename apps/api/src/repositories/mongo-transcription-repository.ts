import type { Collection, Db, Document, WithId } from 'mongodb';

export type TranscriptionJobState = 'queued' | 'processing' | 'completed' | 'failed';

export interface TranscriptionJob {
  recordingId: string;
  state: TranscriptionJobState;
  provider: 'openai';
  model: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  processingStartedAt?: string;
  completedAt?: string;
  transcriptText?: string;
  languageCodes?: string[];
  errorCode?: string;
  errorMessage?: string;
  retryable?: boolean;
  providerRequestId?: string;
}

export interface TranscriptionJobRepository {
  enqueue(recordingId: string, model?: string): Promise<TranscriptionJob>;
  retry(recordingId: string): Promise<TranscriptionJob | undefined>;
  get(recordingId: string): Promise<TranscriptionJob | undefined>;
  claimNext(recordingId?: string, now?: Date): Promise<TranscriptionJob | undefined>;
  markCompleted(input: {
    recordingId: string;
    transcriptText: string;
    languageCodes: string[];
    model: string;
    now?: Date;
  }): Promise<TranscriptionJob | undefined>;
  markFailed(input: {
    recordingId: string;
    errorCode: string;
    errorMessage: string;
    retryable: boolean;
    now?: Date;
  }): Promise<TranscriptionJob | undefined>;
}

interface TranscriptionJobDocument extends Omit<TranscriptionJob, 'createdAt' | 'updatedAt' | 'processingStartedAt' | 'completedAt'>, Document {
  createdAt: Date;
  updatedAt: Date;
  processingStartedAt?: Date;
  completedAt?: Date;
}

function jobValue(document: WithId<TranscriptionJobDocument>): TranscriptionJob {
  const { _id: _ignored, ...job } = document;
  return {
    ...job,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
    processingStartedAt: document.processingStartedAt?.toISOString(),
    completedAt: document.completedAt?.toISOString()
  };
}

/** Durable transcript/job storage. Audio bytes remain exclusively in object storage. */
export class MongoTranscriptionRepository {
  private readonly jobs: Collection<TranscriptionJobDocument>;

  constructor(database: Db, private readonly leaseMs = 10 * 60_000) {
    this.jobs = database.collection<TranscriptionJobDocument>('transcription_jobs');
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.jobs.createIndex({ recordingId: 1 }, { unique: true, name: 'transcription_recording_unique' }),
      this.jobs.createIndex({ state: 1, createdAt: 1 }, { name: 'transcription_queue_order' }),
      this.jobs.createIndex({ state: 1, processingStartedAt: 1 }, { name: 'transcription_expired_lease' })
    ]);
  }

  /** Creates the durable queue entry once. Repeated calls leave completed jobs untouched. */
  async enqueue(recordingId: string, model = 'gpt-transcribe'): Promise<TranscriptionJob> {
    const now = new Date();
    await this.jobs.updateOne(
      { recordingId },
      {
        $setOnInsert: {
          recordingId,
          state: 'queued',
          provider: 'openai',
          model,
          attempts: 0,
          createdAt: now,
          updatedAt: now
        }
      },
      { upsert: true }
    );
    const job = await this.get(recordingId);
    if (!job) throw new Error('The transcription job could not be created.');
    return job;
  }

  /** Explicitly requeues a failed job; completed and actively leased jobs remain unchanged. */
  async retry(recordingId: string): Promise<TranscriptionJob | undefined> {
    await this.jobs.updateOne(
      { recordingId, state: 'failed', retryable: true },
      {
        $set: { state: 'queued', updatedAt: new Date() },
        $unset: { errorCode: '', errorMessage: '', retryable: '', processingStartedAt: '' }
      }
    );
    return this.get(recordingId);
  }

  async get(recordingId: string): Promise<TranscriptionJob | undefined> {
    const job = await this.jobs.findOne({ recordingId });
    return job ? jobValue(job) : undefined;
  }

  /**
   * Atomically claims one queued job or reclaims one whose worker lease expired.
   * The claim is persistent, so a process restart can resume old queue items.
   */
  async claimNext(recordingId?: string, now = new Date()): Promise<TranscriptionJob | undefined> {
    const staleBefore = new Date(now.getTime() - this.leaseMs);
    const eligibility: Document = {
      $or: [
        { state: 'queued' },
        { state: 'processing', processingStartedAt: { $lt: staleBefore } }
      ]
    };
    if (recordingId) eligibility.recordingId = recordingId;
    const claimed = await this.jobs.findOneAndUpdate(
      eligibility,
      {
        $set: { state: 'processing', processingStartedAt: now, updatedAt: now },
        $inc: { attempts: 1 }
      },
      { sort: { createdAt: 1 }, returnDocument: 'after' }
    );
    return claimed ? jobValue(claimed) : undefined;
  }

  async markCompleted(input: {
    recordingId: string;
    transcriptText: string;
    languageCodes: string[];
    model: string;
    now?: Date;
  }): Promise<TranscriptionJob | undefined> {
    const now = input.now ?? new Date();
    const updated = await this.jobs.findOneAndUpdate(
      { recordingId: input.recordingId, state: 'processing' },
      {
        $set: {
          state: 'completed',
          provider: 'openai',
          model: input.model,
          transcriptText: input.transcriptText,
          languageCodes: input.languageCodes,
          updatedAt: now,
          completedAt: now
        },
        $unset: { errorCode: '', errorMessage: '', retryable: '', processingStartedAt: '' }
      },
      { returnDocument: 'after' }
    );
    return updated ? jobValue(updated) : undefined;
  }

  async markFailed(input: {
    recordingId: string;
    errorCode: string;
    errorMessage: string;
    retryable: boolean;
    now?: Date;
  }): Promise<TranscriptionJob | undefined> {
    const now = input.now ?? new Date();
    const updated = await this.jobs.findOneAndUpdate(
      { recordingId: input.recordingId, state: 'processing' },
      {
        $set: {
          state: 'failed',
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          retryable: input.retryable,
          updatedAt: now
        },
        $unset: { processingStartedAt: '' }
      },
      { returnDocument: 'after' }
    );
    return updated ? jobValue(updated) : undefined;
  }
}

export async function createMongoTranscriptionRepository(database: Db): Promise<MongoTranscriptionRepository> {
  const repository = new MongoTranscriptionRepository(database);
  await repository.initialize();
  return repository;
}
