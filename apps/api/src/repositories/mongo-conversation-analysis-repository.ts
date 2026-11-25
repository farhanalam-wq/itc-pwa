import type {
  Confidence,
  ConversationAnalysisReport,
  RecordingConversationAnalysis,
  VisitOutcome
} from '@itc/domain';
import type { Collection, Db, Document, WithId } from 'mongodb';

interface ConversationAnalysisDocument extends Omit<RecordingConversationAnalysis, 'createdAt' | 'updatedAt' | 'completedAt'>, Document {
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  attempts: number;
  processingStartedAt?: Date;
  analysisAudioObjectKey?: string;
  analysisAudioSha256?: string;
}

interface RecordingDocument extends Document {
  id: string;
  startedAt: string;
  syncState: string;
  conversationAnalysisState?: string;
  territoryId?: string;
  representativeId?: string;
  outletId?: string;
  outletName?: string;
  denoisedAnalysisAudio?: { state?: string; syncState?: string; objectKey?: string };
}

function analysisValue(document: WithId<ConversationAnalysisDocument>): RecordingConversationAnalysis {
  const { _id: _ignored, attempts: _attempts, processingStartedAt: _processingStartedAt,
    analysisAudioObjectKey: _analysisAudioObjectKey, analysisAudioSha256: _analysisAudioSha256, ...analysis } = document;
  return {
    ...analysis,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
    completedAt: document.completedAt?.toISOString()
  };
}

function blankAnalysis(recordingId: string, model: string, version: string, state: RecordingConversationAnalysis['state'] = 'not_started'): RecordingConversationAnalysis {
  const now = new Date().toISOString();
  return {
    recordingId, state, provider: 'openai', model, analysisVersion: version,
    createdAt: now, updatedAt: now,
    outcome: 'not_stated', outcomeConfidence: 'low', outcomeExplicitness: 'uncertain', outcomeEvidence: [],
    confirmedOrders: [], salesSignals: [], sentimentCue: 'unknown', sentimentConfidence: 'low',
    nextActionEvidence: [], coachingSignals: []
  };
}

const outcomes: VisitOutcome[] = ['order_placed', 'follow_up', 'no_order', 'new_outlet', 'not_stated'];
const confidences: Confidence[] = ['high', 'medium', 'low'];
const explicitnesses = ['explicit', 'inferred', 'uncertain'] as const;

export interface ConversationAnalysisReportFilter {
  from?: string;
  to?: string;
  territoryId?: string;
  representativeId?: string;
}

export class MongoConversationAnalysisRepository {
  private readonly analyses: Collection<ConversationAnalysisDocument>;
  private readonly recordings: Collection<RecordingDocument>;
  private readonly transcripts: Collection<Document>;

  constructor(private readonly database: Db, private readonly leaseMs = 10 * 60_000) {
    this.analyses = database.collection<ConversationAnalysisDocument>('conversation_analyses');
    this.recordings = database.collection<RecordingDocument>('recordings');
    this.transcripts = database.collection('transcription_jobs');
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.analyses.createIndex({ recordingId: 1 }, { unique: true, name: 'conversation_analysis_recording_unique' }),
      this.analyses.createIndex({ state: 1, createdAt: 1 }, { name: 'conversation_analysis_queue' }),
      this.analyses.createIndex({ state: 1, processingStartedAt: 1 }, { name: 'conversation_analysis_expired_lease' })
    ]);
  }

  async enqueue(recordingId: string, model: string, version: string, artifact: { objectKey: string; sha256: string }): Promise<RecordingConversationAnalysis> {
    const now = new Date();
    const existing = await this.analyses.findOne({ recordingId });
    if (!existing) {
      await this.analyses.updateOne({ recordingId }, {
        $setOnInsert: {
        recordingId, state: 'queued', provider: 'openai', model, analysisVersion: version,
        createdAt: now, updatedAt: now, attempts: 0,
        analysisAudioObjectKey: artifact.objectKey, analysisAudioSha256: artifact.sha256,
        outcome: 'not_stated', outcomeConfidence: 'low', outcomeExplicitness: 'uncertain', outcomeEvidence: [],
        confirmedOrders: [], salesSignals: [], sentimentCue: 'unknown', sentimentConfidence: 'low',
        nextActionEvidence: [], coachingSignals: []
        }
      }, { upsert: true });
    } else if ((existing.analysisAudioObjectKey !== artifact.objectKey || existing.analysisAudioSha256 !== artifact.sha256)
      && existing.state !== 'processing') {
      await this.analyses.updateOne({ recordingId, state: { $ne: 'processing' } }, {
        $set: {
          state: 'queued', model, analysisVersion: version, updatedAt: now,
          analysisAudioObjectKey: artifact.objectKey, analysisAudioSha256: artifact.sha256,
          outcome: 'not_stated', outcomeConfidence: 'low', outcomeExplicitness: 'uncertain', outcomeEvidence: [],
          confirmedOrders: [], salesSignals: [], sentimentCue: 'unknown', sentimentConfidence: 'low',
          nextActionEvidence: [], coachingSignals: []
        },
        $unset: { completedAt: '', summary: '', nextAction: '', nextActionDue: '', errorCode: '', errorMessage: '', retryable: '', processingStartedAt: '' }
      });
    }
    const result = await this.get(recordingId);
    if (!result) throw new Error('The conversation analysis job could not be created.');
    return result;
  }

  async get(recordingId: string): Promise<RecordingConversationAnalysis | undefined> {
    const found = await this.analyses.findOne({ recordingId });
    return found ? analysisValue(found) : undefined;
  }

  async delete(recordingId: string): Promise<void> {
    await this.analyses.deleteOne({ recordingId });
  }

  async claimNext(recordingId?: string, now = new Date()): Promise<(RecordingConversationAnalysis & {
    attempt: number; analysisAudioObjectKey?: string; analysisAudioSha256?: string
  }) | undefined> {
    const staleBefore = new Date(now.getTime() - this.leaseMs);
    const query: Document = {
      $or: [
        { state: 'queued' },
        { state: 'processing', processingStartedAt: { $lt: staleBefore } }
      ]
    };
    if (recordingId) query.recordingId = recordingId;
    const claimed = await this.analyses.findOneAndUpdate(query, {
      $set: { state: 'processing', updatedAt: now, processingStartedAt: now },
      $inc: { attempts: 1 },
      $unset: { errorCode: '', errorMessage: '', retryable: '' }
    }, { sort: { createdAt: 1 }, returnDocument: 'after' });
    return claimed ? {
      ...analysisValue(claimed), attempt: claimed.attempts,
      analysisAudioObjectKey: claimed.analysisAudioObjectKey,
      analysisAudioSha256: claimed.analysisAudioSha256
    } : undefined;
  }

  async saveCompleted(recordingId: string, attempt: number, content: Omit<RecordingConversationAnalysis,
    'recordingId' | 'state' | 'provider' | 'model' | 'analysisVersion' | 'createdAt' | 'updatedAt' | 'completedAt' | 'errorCode' | 'errorMessage' | 'retryable'>,
    model: string, version: string): Promise<RecordingConversationAnalysis | undefined> {
    const now = new Date();
    const updated = await this.analyses.findOneAndUpdate({ recordingId, state: 'processing', attempts: attempt }, {
      $set: { ...content, provider: 'openai', model, analysisVersion: version, state: 'completed', updatedAt: now, completedAt: now },
      $unset: { processingStartedAt: '', errorCode: '', errorMessage: '', retryable: '' }
    }, { returnDocument: 'after' });
    return updated ? analysisValue(updated) : undefined;
  }

  async markFailed(recordingId: string, attempt: number, errorCode: string, errorMessage: string, retryable: boolean): Promise<RecordingConversationAnalysis | undefined> {
    const updated = await this.analyses.findOneAndUpdate({ recordingId, state: 'processing', attempts: attempt }, {
      $set: { state: 'failed', errorCode, errorMessage, retryable, updatedAt: new Date() },
      $unset: { processingStartedAt: '' }
    }, { returnDocument: 'after' });
    return updated ? analysisValue(updated) : undefined;
  }

  async retry(recordingId: string): Promise<RecordingConversationAnalysis | undefined> {
    const updated = await this.analyses.updateOne({
      recordingId,
      state: 'failed',
      $or: [
        { retryable: true },
        { errorCode: { $in: ['transcript_unavailable', 'transcript_artifact_mismatch'] } }
      ]
    }, {
      $set: { state: 'queued', updatedAt: new Date() },
      $unset: { errorCode: '', errorMessage: '', retryable: '', processingStartedAt: '' }
    });
    if (updated.modifiedCount !== 1) return undefined;
    return this.get(recordingId);
  }

  async reprocess(recordingId: string, model: string, version: string, artifact: { objectKey: string; sha256: string }): Promise<RecordingConversationAnalysis | undefined> {
    const now = new Date();
    const updated = await this.analyses.findOneAndUpdate({ recordingId, state: 'completed' }, {
      $set: {
        state: 'queued', updatedAt: now, model, analysisVersion: version,
        analysisAudioObjectKey: artifact.objectKey, analysisAudioSha256: artifact.sha256,
        outcome: 'not_stated', outcomeConfidence: 'low', outcomeExplicitness: 'uncertain', outcomeEvidence: [],
        confirmedOrders: [], salesSignals: [], sentimentCue: 'unknown', sentimentConfidence: 'low',
        nextActionEvidence: [], coachingSignals: []
      },
      $unset: { completedAt: '', summary: '', nextAction: '', nextActionDue: '', errorCode: '', errorMessage: '', retryable: '' }
    }, { returnDocument: 'after' });
    return updated ? analysisValue(updated) : undefined;
  }

  async findTranscriptionsWithoutAnalysis(limit = 100): Promise<string[]> {
    const results = await this.recordings.aggregate<{ id: string }>([
      { $match: {
        syncState: 'uploaded',
        'denoisedAnalysisAudio.state': 'ready',
        'denoisedAnalysisAudio.sampleRateHz': 48000,
        'denoisedAnalysisAudio.durationSeconds': { $gt: 0 },
        'denoisedAnalysisAudio.syncState': 'uploaded',
        'denoisedAnalysisAudio.objectKey': { $type: 'string' },
        'denoisedAnalysisAudio.sha256': { $type: 'string' }
      } },
      { $lookup: { from: 'transcription_jobs', localField: 'id', foreignField: 'recordingId', as: 'transcript' } },
      { $match: { 'transcript.state': 'completed' } },
      { $lookup: { from: 'conversation_analyses', localField: 'id', foreignField: 'recordingId', as: 'analysis' } },
      { $match: { 'analysis.0': { $exists: false } } },
      { $limit: limit }, { $project: { _id: 0, id: 1 } }
    ]).toArray();
    return results.map(({ id }) => id);
  }

  async buildReport(filters: ConversationAnalysisReportFilter, now = new Date()): Promise<ConversationAnalysisReport> {
    const startedAt: Document = {};
    if (filters.from) startedAt.$gte = `${filters.from}T00:00:00.000Z`;
    if (filters.to) startedAt.$lte = `${filters.to}T23:59:59.999Z`;
    const match: Document = { syncState: 'uploaded' };
    if (Object.keys(startedAt).length) match.startedAt = startedAt;
    if (filters.territoryId) match.territoryId = filters.territoryId;
    if (filters.representativeId) match.representativeId = filters.representativeId;
    const outcomeCounts = Object.fromEntries(outcomes.map((outcome) => [outcome, 0])) as Record<VisitOutcome, number>;
    const emptyConfidence = () => Object.fromEntries(confidences.map((confidence) => [confidence, 0])) as Record<Confidence, number>;
    const emptyExplicitness = () => Object.fromEntries(explicitnesses.map((value) => [value, 0])) as Record<'explicit' | 'inferred' | 'uncertain', number>;
    const signalMetrics = new Map<string, { taxonomyKey: string; category: string; mentionCount: number; recordingIds: Set<string>; outlets: Set<string>; confidenceCounts: Record<Confidence, number>; explicitnessCounts: Record<'explicit' | 'inferred' | 'uncertain', number> }>();
    const territoryCounts = new Map<string, { recordingCount: number; analyzedRecordingCount: number }>();
    const representativeCounts = new Map<string, { recordingCount: number; analyzedRecordingCount: number }>();
    let captureCount = 0, analyzedRecordingCount = 0, failedRecordingCount = 0;
    let confirmedOrderCount = 0, confirmedOrdersWithValueCount = 0, confirmedOrderValueInr = 0;
    let actionCount = 0, datedActionCount = 0, overdueActionCount = 0;
    let findingCount = 0, evidenceLinkedFindingCount = 0, highConfidenceFindingCount = 0, mediumConfidenceFindingCount = 0, lowConfidenceFindingCount = 0, uncertainFindingCount = 0;
    const cursor = this.recordings.aggregate([
      { $match: match },
      { $lookup: { from: 'conversation_analyses', localField: 'id', foreignField: 'recordingId', as: 'analysis' } },
      { $unwind: { path: '$analysis', preserveNullAndEmptyArrays: true } },
      { $project: {
        id: 1, startedAt: 1, territoryId: 1, representativeId: 1, outletId: 1, outletName: 1,
        conversationAnalysisState: 1, denoisedAnalysisAudio: 1, analysis: 1
      } }
    ], { allowDiskUse: true });
    for await (const row of cursor) {
      const recordingId = String(row.id);
      captureCount += 1;
      const analysis = row.analysis as RecordingConversationAnalysis | undefined;
      const isComplete = analysis?.state === 'completed';
      if (isComplete) analyzedRecordingCount += 1;
      else if (analysis?.state === 'failed' || row.conversationAnalysisState === 'failed'
        || row.denoisedAnalysisAudio?.state !== 'ready'
        || row.denoisedAnalysisAudio?.sampleRateHz !== 48_000
        || row.denoisedAnalysisAudio?.syncState !== 'uploaded'
        || !row.denoisedAnalysisAudio?.objectKey || !row.denoisedAnalysisAudio?.sha256
        || !row.denoisedAnalysisAudio?.durationSeconds) failedRecordingCount += 1;
      for (const [map, key] of [[territoryCounts, row.territoryId], [representativeCounts, row.representativeId]] as const) {
        if (typeof key !== 'string' || !key) continue;
        const value = map.get(key) ?? { recordingCount: 0, analyzedRecordingCount: 0 };
        value.recordingCount += 1;
        if (isComplete) value.analyzedRecordingCount += 1;
        map.set(key, value);
      }
      if (!isComplete || !analysis) continue;
      outcomeCounts[analysis.outcome] += 1;
      const outletKey = String(row.outletId ?? row.outletName ?? recordingId);
      // Evidence coverage is scoped to outcome, order-intent, and sales-signal findings.
      // Follow-ups have their own counters; coaching and follow-up types do not carry
      // every confidence/explicitness field needed to join this denominator honestly.
      const findings = [
        { confidence: analysis.outcomeConfidence, explicitness: analysis.outcomeExplicitness, evidence: analysis.outcomeEvidence },
        ...analysis.confirmedOrders.map((item) => ({ confidence: item.confidence, explicitness: item.intent === 'confirmed' ? 'explicit' as const : 'uncertain' as const, evidence: item.evidence })),
        ...analysis.salesSignals.map((item) => ({ confidence: item.confidence, explicitness: item.explicitness, evidence: item.evidence }))
      ];
      for (const finding of findings) {
        findingCount += 1;
        if (finding.evidence.length) evidenceLinkedFindingCount += 1;
        if (finding.confidence === 'high') highConfidenceFindingCount += 1;
        else if (finding.confidence === 'medium') mediumConfidenceFindingCount += 1;
        else lowConfidenceFindingCount += 1;
        if (finding.explicitness === 'uncertain') uncertainFindingCount += 1;
      }
      for (const order of analysis.confirmedOrders) {
        if (order.intent !== 'confirmed' || !order.evidence.length) continue;
        confirmedOrderCount += 1;
        if (typeof order.totalValueInr === 'number') {
          confirmedOrdersWithValueCount += 1;
          confirmedOrderValueInr += order.totalValueInr;
        }
      }
      for (const signal of analysis.salesSignals) {
        const id = `${signal.category}:${signal.taxonomyKey}`;
        const metric = signalMetrics.get(id) ?? {
          taxonomyKey: signal.taxonomyKey, category: signal.category, mentionCount: 0,
          recordingIds: new Set<string>(), outlets: new Set<string>(), confidenceCounts: emptyConfidence(), explicitnessCounts: emptyExplicitness()
        };
        metric.mentionCount += signal.mentionCount;
        metric.recordingIds.add(recordingId);
        metric.outlets.add(outletKey);
        metric.confidenceCounts[signal.confidence] += 1;
        metric.explicitnessCounts[signal.explicitness] += 1;
        signalMetrics.set(id, metric);
      }
      if (analysis.nextAction) {
        actionCount += 1;
        if (analysis.nextActionDue) {
          datedActionCount += 1;
          if (new Date(analysis.nextActionDue).getTime() < now.getTime()) overdueActionCount += 1;
        }
      }
    }
    return {
      generatedAt: now.toISOString(), filters,
      captureCount, analyzedRecordingCount, pendingRecordingCount: Math.max(0, captureCount - analyzedRecordingCount - failedRecordingCount), failedRecordingCount,
      outcomeCounts, confirmedOrderCount, confirmedOrdersWithValueCount, confirmedOrderValueInr,
      signals: [...signalMetrics.values()].map(({ taxonomyKey, category, mentionCount, recordingIds, outlets, confidenceCounts, explicitnessCounts }) => ({
        taxonomyKey, category: category as ConversationAnalysisReport['signals'][number]['category'],
        mentionCount, recordingCount: recordingIds.size, outletCount: outlets.size, confidenceCounts, explicitnessCounts
      })).sort((a, b) => b.recordingCount - a.recordingCount || a.taxonomyKey.localeCompare(b.taxonomyKey)),
      followUps: { actionCount, datedActionCount, overdueActionCount },
      evidenceCoverage: { findingCount, evidenceLinkedFindingCount, highConfidenceFindingCount, mediumConfidenceFindingCount, lowConfidenceFindingCount, uncertainFindingCount },
      territories: [...territoryCounts].map(([id, value]) => ({ id, ...value })),
      representatives: [...representativeCounts].map(([id, value]) => ({ id, ...value }))
    };
  }
}

export async function createMongoConversationAnalysisRepository(database: Db): Promise<MongoConversationAnalysisRepository> {
  const repository = new MongoConversationAnalysisRepository(database);
  await repository.initialize();
  return repository;
}

export function emptyConversationAnalysis(recordingId: string, model: string, version: string): RecordingConversationAnalysis {
  return blankAnalysis(recordingId, model, version);
}
