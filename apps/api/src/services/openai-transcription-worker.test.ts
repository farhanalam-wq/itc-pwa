import { expect, test } from 'bun:test';
import type { RecordingMetadata } from '@itc/domain';
import type { RecordingRepository } from '../repositories/demo-repository';
import type { TranscriptionJob, TranscriptionJobRepository } from '../repositories/mongo-transcription-repository';
import type { RecordingObjectStorage } from './storage/recording-storage';
import type { DiarizedTranscriptionPipeline } from './diarized-transcription';
import type { AudioTranscriptionProvider } from './openai-transcription';
import { OpenAITranscriptionWorker } from './openai-transcription-worker';

const now = new Date().toISOString();

test('sends a legacy whole-file job through the mandatory diarization pipeline', async () => {
  const legacyJob: TranscriptionJob = {
    recordingId: 'synthetic-recording',
    state: 'processing',
    provider: 'openai',
    model: 'gpt-transcribe',
    attempts: 1,
    createdAt: now,
    updatedAt: now
  };
  const recording: RecordingMetadata = {
    id: legacyJob.recordingId,
    startedAt: now,
    durationSeconds: 1,
    mimeType: 'audio/webm',
    byteLength: 4,
    syncState: 'uploaded',
    analysisState: 'not_started',
    storageDriver: 'local',
    objectKey: 'local-recordings/2026/11/22/synthetic-recording.webm'
  };
  let pipelineCalls = 0;
  let directProviderCalls = 0;
  let enqueuedMode: 'diarized' | undefined;
  let completedInput: Parameters<TranscriptionJobRepository['markCompleted']>[0] | undefined;

  const jobs = {
    claimNext: async () => legacyJob,
    checkpoint: async () => true,
    markCompleted: async (input: Parameters<TranscriptionJobRepository['markCompleted']>[0]) => {
      completedInput = input;
      return {
        ...legacyJob,
        state: 'completed' as const,
        transcriptText: input.transcriptText,
        turns: input.turns,
        diarizer: input.diarizer
      };
    },
    markFailed: async () => undefined,
    get: async () => undefined,
    enqueue: async (_recordingId: string, _model?: string, mode?: 'diarized') => {
      enqueuedMode = mode;
      return { ...legacyJob, state: 'queued' as const, mode };
    },
    delete: async () => undefined,
    retry: async () => undefined,
    reprocess: async () => undefined
  } as unknown as TranscriptionJobRepository;

  const repository = {
    getRecording: async () => recording,
    transitionAnalysisState: async () => true
  } as unknown as RecordingRepository;
  const storage = {
    readFinal: async () => new Uint8Array([1, 2, 3, 4])
  } as unknown as RecordingObjectStorage;
  const provider: AudioTranscriptionProvider = {
    async transcribe() {
      directProviderCalls += 1;
      throw new Error('The whole-file fallback must not run.');
    }
  };
  const diarized = {
    async transcribe({ job, bytes }: { job: TranscriptionJob; bytes: Uint8Array }) {
      pipelineCalls += 1;
      expect(job.mode).toBeUndefined();
      expect([...bytes]).toEqual([1, 2, 3, 4]);
      return {
        text: 'Speaker 1: synthetic words',
        turns: [{ id: 'turn-1', speaker: 'Speaker 1', startMs: 0, endMs: 1000, text: 'synthetic words', overlapsSpeech: false }],
        diarizer: { model: 'pyannote/speaker-diarization-community-1', revision: 'synthetic-revision' },
        languageCodes: ['en'],
        model: 'gpt-transcribe'
      };
    }
  } as unknown as DiarizedTranscriptionPipeline;

  const worker = new OpenAITranscriptionWorker(jobs, repository, storage, provider, diarized);
  await worker.enqueue(legacyJob.recordingId);
  expect(enqueuedMode).toBe('diarized');
  const result = await worker.runNext(legacyJob.recordingId);

  expect(result.state).toBe('completed');
  expect(pipelineCalls).toBe(1);
  expect(directProviderCalls).toBe(0);
  expect(completedInput?.diarizer?.model).toBe('pyannote/speaker-diarization-community-1');
  expect(completedInput?.turns).toHaveLength(1);
});
