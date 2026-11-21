import { expect, test } from 'bun:test';
import type { TranscriptionJob } from '../repositories/mongo-transcription-repository';
import { wavFromPcm } from './diarization-audio';
import { DiarizedTranscriptionPipeline } from './diarized-transcription';
import { AudioTranscriptionError, type AudioTranscriptionProvider } from './openai-transcription';

test('persists the Modal job before polling and resumes only missing clips', async () => {
  let modalCalls = 0;
  let progress: TranscriptionJob['diarization'];
  const pipeline = new DiarizedTranscriptionPipeline({
    async run(_pcm, options) {
      modalCalls += 1;
      await options?.onJobId?.('fc-synthetic');
      expect(progress?.modalJobId).toBe('fc-synthetic');
      return {
        jobId: 'fc-synthetic',
        modelRevision: 'synthetic-revision',
        timeline: {
          source: 'synthetic-model',
          turns: [
            { speaker: 'A', startMs: 0, endMs: 400 },
            { speaker: 'B', startMs: 500, endMs: 1000 }
          ],
          overlaps: [{ startMs: 550, endMs: 650 }]
        }
      };
    }
  });
  const calls: string[] = [];
  const provider: AudioTranscriptionProvider = {
    async transcribe({ recordingId }) {
      calls.push(recordingId);
      if (calls.length === 2) throw new AudioTranscriptionError('provider_unavailable', 'Synthetic timeout.', true);
      return {
        text: recordingId.endsWith('turn-1') ? 'Synthetic English' : 'কৃত্রিম বাংলা',
        languageCodes: [recordingId.endsWith('turn-1') ? 'en' : 'bn'],
        model: 'gpt-transcribe'
      };
    }
  };
  const job: TranscriptionJob = {
    recordingId: 'synthetic-audio',
    state: 'processing',
    mode: 'diarized',
    provider: 'openai',
    model: 'gpt-transcribe',
    attempts: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const input = {
    bytes: wavFromPcm(new Uint8Array(32_000)),
    mimeType: 'audio/wav',
    provider,
    checkpoint: async (_stage: string, value: NonNullable<TranscriptionJob['diarization']>) => {
      progress = structuredClone(value);
    },
    signal: new AbortController().signal
  };

  await expect(pipeline.transcribe({ ...input, job })).rejects.toThrow('Synthetic timeout.');
  expect(progress?.clips?.[0]?.text).toBe('Synthetic English');
  expect(progress?.clips?.[1]?.text).toBeUndefined();

  const completed = await pipeline.transcribe({ ...input, job: { ...job, attempts: 2, diarization: progress } });
  expect(modalCalls).toBe(1);
  expect(calls).toEqual(['synthetic-audio-turn-1', 'synthetic-audio-turn-2', 'synthetic-audio-turn-2']);
  expect(completed.turns.map(({ text, overlapsSpeech }) => ({ text, overlapsSpeech }))).toEqual([
    { text: 'Synthetic English', overlapsSpeech: false },
    { text: 'কৃত্রিম বাংলা', overlapsSpeech: true }
  ]);
  expect(completed.diarizer).toEqual({ model: 'synthetic-model', revision: 'synthetic-revision' });
  expect(completed.languageCodes).toEqual(['en', 'bn']);
});
