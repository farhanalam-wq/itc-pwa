import { expect, test } from 'bun:test';
import { MongoConversationAnalysisRepository } from './mongo-conversation-analysis-repository';
import type { RecordingConversationAnalysis } from '@itc/domain';

function analysis(): RecordingConversationAnalysis {
  const evidence = [{ segmentIds: ['turn-1'], quote: 'Add one case today.', startMs: 1000, endMs: 1800 }];
  return {
    recordingId: 'r1', state: 'completed', provider: 'openai', model: 'gpt-4o-mini', analysisVersion: 'test',
    createdAt: '2026-11-22T10:00:00.000Z', updatedAt: '2026-11-22T10:01:00.000Z', completedAt: '2026-11-22T10:01:00.000Z',
    outcome: 'order_placed', outcomeConfidence: 'high', outcomeExplicitness: 'explicit', outcomeEvidence: evidence,
    confirmedOrders: [
      { id: 'o1', intent: 'confirmed', quantity: 1, quantityUnit: 'case', totalValueInr: 120, confidence: 'high', evidence },
      { id: 'o2', intent: 'conditional', quantity: 4, quantityUnit: 'cases', confidence: 'medium', evidence }
    ],
    salesSignals: [{
      id: 's1', category: 'availability', taxonomyKey: 'stock_out', title: 'Stock-out', summary: 'Pack was unavailable.',
      confidence: 'medium', explicitness: 'explicit', mentionCount: 2, evidence, status: 'reported'
    }],
    sentimentCue: 'neutral', sentimentConfidence: 'low', nextAction: 'Confirm delivery', nextActionDue: '2026-11-21',
    nextActionEvidence: evidence, coachingSignals: []
  };
}

test('report counts confirmed orders separately from conditional intent and marks missing audio failed', async () => {
  const rows = [
    { id: 'r1', startedAt: '2026-11-20T10:00:00.000Z', territoryId: 't1', representativeId: 'rep1', outletId: 'o1', conversationAnalysisState: 'completed', analysis: analysis() },
    { id: 'r2', startedAt: '2026-11-20T11:00:00.000Z', territoryId: 't1', representativeId: 'rep1', conversationAnalysisState: 'failed' },
    { id: 'r3', startedAt: '2026-11-20T12:00:00.000Z', territoryId: 't2', representativeId: 'rep2', conversationAnalysisState: 'queued', denoisedAnalysisAudio: { state: 'ready', syncState: 'uploaded', objectKey: 'r3.analysis.webm', sha256: 'b'.repeat(64), sampleRateHz: 48_000, durationSeconds: 30 } }
  ];
  const collection = { aggregate: () => ({ async *[Symbol.asyncIterator]() { yield* rows; } }) };
  const database = { collection: () => collection } as never;
  const repository = new MongoConversationAnalysisRepository(database);
  const report = await repository.buildReport({ from: '2026-11-20' }, new Date('2026-11-22T00:00:00.000Z'));

  expect(report.captureCount).toBe(3);
  expect(report.analyzedRecordingCount).toBe(1);
  expect(report.failedRecordingCount).toBe(1);
  expect(report.pendingRecordingCount).toBe(1);
  expect(report.confirmedOrderCount).toBe(1);
  expect(report.confirmedOrdersWithValueCount).toBe(1);
  expect(report.confirmedOrderValueInr).toBe(120);
  expect(report.followUps).toEqual({ actionCount: 1, datedActionCount: 1, overdueActionCount: 1 });
  expect(report.signals[0]).toMatchObject({ taxonomyKey: 'stock_out', mentionCount: 2, recordingCount: 1, outletCount: 1 });
});
