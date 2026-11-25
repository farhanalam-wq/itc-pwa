import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RecordingMetadata } from '@itc/domain';
import { createApp } from './app';
import { DemoRecordingRepository } from './repositories/demo-repository';
import { LocalRecordingStorage } from './services/local-recording-storage';
import type { RecordingObjectStorage } from './services/storage/recording-storage';
import type { OpenAITranscriptionWorker } from './services/openai-transcription-worker';
import type { TranscriptionJobRepository } from './repositories/mongo-transcription-repository';
import type { AdminAuthService } from './auth/admin-auth';

test('raw upload never queues Pyannote; denoised analysis artifact completion does', async () => {
  const root = await mkdtemp(join(tmpdir(), 'itc-analysis-route-'));
  try {
    const repository = new DemoRecordingRepository();
    const rawBytes = new Uint8Array([1, 2, 3, 4]);
    const analysisBytes = new Uint8Array([5, 6, 7]);
    const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const objectStorage: RecordingObjectStorage = {
      driver: 'local',
      async putFinal(input) {
        return {
          driver: 'local', objectKey: `local-recordings/${input.id}${input.artifact === 'analysis' ? '.analysis' : ''}.webm`,
          byteLength: input.bytes.byteLength, mimeType: input.mimeType, sha256: hash(input.bytes)
        };
      },
      async readFinal(objectKey) { return objectKey.includes('.analysis.') ? analysisBytes : rawBytes; },
      async deleteFinal() {},
      async createDownloadUrl() { throw new Error('unused'); }
    };
    const queueCalls: string[] = [];
    const transcriptionWorker = {
      async enqueue(recordingId: string) { queueCalls.push(recordingId); return { state: 'queued' }; },
      async runNext() { return { state: 'not_ready' }; }
    } as unknown as OpenAITranscriptionWorker;
    const adminAuth = {
      cookieSecure: false,
      async getSession(token: string | undefined) {
        return token === 'test-session' ? { id: 'primary' as const, email: 'manager@example.test', displayName: 'Test Manager' } : undefined;
      }
    } as AdminAuthService;
    const app = createApp(
      repository, undefined, undefined, new LocalRecordingStorage(root), objectStorage,
      adminAuth, transcriptionWorker, {} as TranscriptionJobRepository
    );
    const visitResponse = await app.handle('/v1/visits', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'visit-1', consentRecordedAt: '2026-11-22T10:00:00.000Z' })
    });
    expect(visitResponse.status).toBe(201);

    const recordingResponse = await app.handle('/v1/visits/visit-1/recordings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'recording-1', startedAt: '2026-11-22T10:00:00.000Z', durationSeconds: 1,
        mimeType: 'audio/webm', byteLength: rawBytes.length,
        denoisedAnalysisAudio: {
          state: 'ready', mimeType: 'audio/webm', byteLength: analysisBytes.length,
          sampleRateHz: 48_000, durationSeconds: 1, model: 'DeepFilterNet3', modelVersion: 'test'
        }
      })
    });
    expect(recordingResponse.status).toBe(201);

    const putChunk = (path: string, bytes: Uint8Array) => app.handle(path, {
      method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from(bytes)
    });
    expect((await putChunk('/v1/recordings/recording-1/audio/0/1', rawBytes)).status).toBe(200);
    expect((await app.handle('/v1/recordings/recording-1/audio/complete', { method: 'POST' })).status).toBe(200);
    expect(queueCalls).toEqual([]);

    expect((await putChunk('/v1/recordings/recording-1/analysis-audio/0/1', analysisBytes)).status).toBe(200);
    expect((await app.handle('/v1/recordings/recording-1/analysis-audio/complete', { method: 'POST' })).status).toBe(200);
    expect(queueCalls).toEqual(['recording-1']);
    const saved = await repository.getRecording('recording-1') as RecordingMetadata;
    expect(saved.objectKey).toContain('recording-1.webm');
    expect(saved.denoisedAnalysisAudio?.objectKey).toContain('recording-1.analysis.webm');
    expect(saved.denoisedAnalysisAudio?.sha256).toBe(hash(analysisBytes));

    const unauthenticated = await app.handle('/v1/recordings/recording-1/download-url?artifact=denoised');
    expect(unauthenticated.status).toBe(401);
    const headers = { cookie: 'itc_admin_session=test-session' };
    const originalDownload = await app.handle('/v1/recordings/recording-1/download-url', { headers });
    expect(originalDownload.status).toBe(200);
    expect((await originalDownload.json()).objectKey).toBe(saved.objectKey);
    const denoisedDownload = await app.handle('/v1/recordings/recording-1/download-url?artifact=denoised', { headers });
    expect(denoisedDownload.status).toBe(200);
    expect((await denoisedDownload.json()).objectKey).toBe(saved.denoisedAnalysisAudio?.objectKey);

    // Synthetic short recording whose cleanup was interrupted: original is stored,
    // but this must not claim that a sales model job failed or offer a false result.
    const incompleteResponse = await app.handle('/v1/visits/visit-1/recordings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'short-recording', startedAt: '2026-11-22T10:00:00.000Z', durationSeconds: 11,
        mimeType: 'audio/webm', byteLength: rawBytes.length,
        denoisedAnalysisAudio: { state: 'incomplete', errorCode: 'denoiser_qualification_pending' }
      })
    });
    expect(incompleteResponse.status).toBe(201);
    expect((await incompleteResponse.json()).conversationAnalysisState).toBe('not_started');
    await putChunk('/v1/recordings/short-recording/audio/0/1', rawBytes);
    expect((await app.handle('/v1/recordings/short-recording/audio/complete', { method: 'POST' })).status).toBe(200);
    const blockedAnalysis = await app.handle('/v1/recordings/short-recording/conversation-analysis', { headers });
    expect(blockedAnalysis.status).toBe(200);
    expect(await blockedAnalysis.json()).toMatchObject({ state: 'not_started', errorCode: 'denoised_audio_unavailable' });

    const denoisedPlayback = await app.handle('/v1/recordings/recording-1/audio?artifact=denoised', { headers });
    expect(denoisedPlayback.status).toBe(200);
    expect(denoisedPlayback.headers.get('content-type')).toBe('audio/webm');
    expect([...new Uint8Array(await denoisedPlayback.arrayBuffer())]).toEqual([...analysisBytes]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
