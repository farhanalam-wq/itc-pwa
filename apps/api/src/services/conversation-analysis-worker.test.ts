import { expect, test } from 'bun:test';
import type { RecordingConversationAnalysis, RecordingMetadata, RecordingTranscriptTurn } from '@itc/domain';
import type { TranscriptionJob } from '../repositories/mongo-transcription-repository';
import { ConversationAnalysisWorker } from './conversation-analysis-worker';

test('records transcripts without speaker turns and automatically requeues after transcript repair', async () => {
  const turns: RecordingTranscriptTurn[] = [];
  let analysis: RecordingConversationAnalysis | undefined;
  let conversationState: RecordingMetadata['conversationAnalysisState'] = 'not_started';
  const recording: RecordingMetadata = {
    id: 'recording-1', startedAt: '2026-11-25T10:00:00.000Z', durationSeconds: 30,
    mimeType: 'audio/webm', byteLength: 100, syncState: 'uploaded', analysisState: 'ready',
    denoisedAnalysisAudio: {
      state: 'ready', syncState: 'uploaded', objectKey: 'recording-1.analysis.webm',
      sha256: 'a'.repeat(64), sampleRateHz: 48_000, durationSeconds: 30
    }
  };
  const transcript: TranscriptionJob = {
    recordingId: recording.id, state: 'completed', provider: 'openai', model: 'test', attempts: 1,
    createdAt: recording.startedAt, updatedAt: recording.startedAt, turns
  };
  const analyses = {
    async get() { return analysis; },
    async enqueue(recordingId: string, model: string, analysisVersion: string, artifact: { objectKey: string; sha256: string }) {
      if (!analysis) {
        analysis = {
          recordingId, state: 'queued', provider: 'openai', model, analysisVersion,
          createdAt: recording.startedAt, updatedAt: recording.startedAt,
          outcome: 'not_stated', outcomeConfidence: 'low', outcomeExplicitness: 'uncertain', outcomeEvidence: [],
          confirmedOrders: [], salesSignals: [], sentimentCue: 'unknown', sentimentConfidence: 'low',
          nextActionEvidence: [], coachingSignals: [],
          analysisAudioObjectKey: artifact.objectKey, analysisAudioSha256: artifact.sha256
        } as RecordingConversationAnalysis;
      }
      return analysis;
    },
    async retry() {
      if (!analysis || analysis.state !== 'failed' || !['transcript_unavailable', 'transcript_artifact_mismatch'].includes(analysis.errorCode ?? '')) return undefined;
      analysis = { ...analysis, state: 'queued', errorCode: undefined, errorMessage: undefined, retryable: undefined };
      return analysis;
    },
    async claimNext() {
      if (!analysis || analysis.state !== 'queued') return undefined;
      analysis = { ...analysis, state: 'processing' };
      return { ...analysis, attempt: 1, analysisAudioObjectKey: recording.denoisedAnalysisAudio?.objectKey, analysisAudioSha256: recording.denoisedAnalysisAudio?.sha256 };
    },
    async markFailed(_recordingId: string, _attempt: number, errorCode: string, errorMessage: string, retryable: boolean) {
      if (!analysis || analysis.state !== 'processing') return undefined;
      analysis = { ...analysis, state: 'failed', errorCode, errorMessage, retryable };
      return analysis;
    }
  };
  const worker = new ConversationAnalysisWorker(
    analyses as never,
    {
      async getRecording() { return recording; },
      async transitionConversationAnalysisState(_id: string, state: NonNullable<RecordingMetadata['conversationAnalysisState']>) {
        conversationState = state;
        return true;
      }
    } as never,
    {
      async get() { return transcript; }
    } as never,
    { model: 'test' } as never
  );

  const firstEnqueue = await worker.enqueue(recording.id);
  expect(firstEnqueue.state).toBe('queued');
  expect(await worker.runNext(recording.id)).toEqual({ state: 'failed' });
  expect(analysis).toMatchObject({ state: 'failed', errorCode: 'transcript_unavailable', retryable: false });
  expect(conversationState as string).toBe('failed');

  turns.push({ id: 'turn-1', speaker: 'Representative', startMs: 0, endMs: 1000, text: 'Hello.', overlapsSpeech: false });
  transcript.analysisAudioObjectKey = recording.denoisedAnalysisAudio!.objectKey;
  transcript.analysisAudioSha256 = recording.denoisedAnalysisAudio!.sha256;
  expect((await worker.enqueue(recording.id)).state).toBe('queued');
  expect(conversationState as string).toBe('queued');
});
