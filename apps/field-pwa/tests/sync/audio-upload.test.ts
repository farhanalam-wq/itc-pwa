import { afterEach, describe, expect, test } from 'bun:test';
import type { ApiClient } from '@itc/api-client';
import type { LocalRecording } from '../../src/storage/indexed-db';
import { recordingStore } from '../../src/storage/recording-store';
import { uploadPendingAudio } from '../../src/sync/audio-upload';

const originalMethods = {
  listUploadQueue: recordingStore.listUploadQueue,
  readAudio: recordingStore.readAudio,
  readDenoisedAudio: recordingStore.readDenoisedAudio,
  setSyncState: recordingStore.setSyncState,
  setDenoisedAudioSyncState: recordingStore.setDenoisedAudioSyncState
};

afterEach(() => {
  Object.assign(recordingStore, originalMethods);
});

function readyRecording(syncState: LocalRecording['syncState'] = 'queued'): LocalRecording {
  return {
    id: 'recording-1',
    visitId: 'visit-1',
    startedAt: new Date().toISOString(),
    durationSeconds: 15,
    mimeType: 'audio/webm;codecs=opus',
    byteLength: 4,
    syncState,
    analysisState: 'not_started',
    denoisedAudioState: 'ready',
    denoisedAudioFileName: 'recording-1.denoised.webm',
    denoisedAudioMimeType: 'audio/webm;codecs=opus',
    denoisedAudioByteLength: 3,
    denoisedAudioSyncState: 'queued',
    fileName: 'recording-1.webm',
    localState: 'ready',
    metadataRegistrationState: 'registered',
    updatedAt: new Date().toISOString(),
    uploadAttempts: 0
  };
}

describe('uploadPendingAudio', () => {
  test('uploads original audio first, then uploads the denoised sidecar', async () => {
    const calls: string[] = [];
    const recording = readyRecording();
    Object.assign(recordingStore, {
      listUploadQueue: async () => [recording],
      readAudio: async () => new File([new Uint8Array(4)], recording.fileName, { type: recording.mimeType }),
      readDenoisedAudio: async () => new File([new Uint8Array(3)], recording.denoisedAudioFileName!, { type: recording.denoisedAudioMimeType }),
      setSyncState: async (_id: string, state: string) => { calls.push(`raw:${state}`); return recording; },
      setDenoisedAudioSyncState: async (_id: string, state: string) => { calls.push(`sidecar:${state}`); return recording; }
    });
    const client = {
      getRecordingSyncStatus: async () => ({ id: recording.id, syncState: 'queued' as const }),
      uploadRecordingAudio: async () => { calls.push('raw:complete'); return { objectKey: 'raw-key' }; },
      uploadRecordingAnalysisAudio: async () => { calls.push('sidecar:complete'); return { denoisedAnalysisAudio: { objectKey: 'analysis-key' } }; }
    } as unknown as ApiClient;

    const result = await uploadPendingAudio(client);

    expect(result).toMatchObject({ attempted: 1, uploaded: 1, failures: [] });
    expect(calls.indexOf('raw:complete')).toBeLessThan(calls.indexOf('sidecar:complete'));
  });

  test('retries the sidecar when original audio is already uploaded and does not recapture/reupload raw bytes', async () => {
    const calls: string[] = [];
    const recording = readyRecording('uploaded');
    Object.assign(recordingStore, {
      listUploadQueue: async () => [recording],
      readAudio: async () => { throw new Error('raw audio should not be read again'); },
      readDenoisedAudio: async () => new File([new Uint8Array(3)], recording.denoisedAudioFileName!, { type: recording.denoisedAudioMimeType }),
      setSyncState: async (_id: string, state: string) => { calls.push(`raw:${state}`); return recording; },
      setDenoisedAudioSyncState: async (_id: string, state: string) => { calls.push(`sidecar:${state}`); return recording; }
    });
    const client = {
      getRecordingSyncStatus: async () => ({ id: recording.id, syncState: 'uploaded' as const }),
      uploadRecordingAudio: async () => { calls.push('raw:upload'); throw new Error('raw upload should not run'); },
      uploadRecordingAnalysisAudio: async () => { calls.push('sidecar:upload'); return { denoisedAnalysisAudio: { objectKey: 'analysis-key' } }; }
    } as unknown as ApiClient;

    const result = await uploadPendingAudio(client);

    expect(result).toMatchObject({ attempted: 1, uploaded: 1, failures: [] });
    expect(calls).toContain('sidecar:upload');
    expect(calls).not.toContain('raw:upload');
  });

  test('keeps raw upload complete and retryable when sidecar upload fails', async () => {
    const calls: string[] = [];
    const recording = readyRecording();
    Object.assign(recordingStore, {
      listUploadQueue: async () => [recording],
      readAudio: async () => new File([new Uint8Array(4)], recording.fileName, { type: recording.mimeType }),
      readDenoisedAudio: async () => new File([new Uint8Array(3)], recording.denoisedAudioFileName!, { type: recording.denoisedAudioMimeType }),
      setSyncState: async (_id: string, state: string) => { calls.push(`raw:${state}`); return recording; },
      setDenoisedAudioSyncState: async (_id: string, state: string) => { calls.push(`sidecar:${state}`); return recording; }
    });
    const client = {
      getRecordingSyncStatus: async () => ({ id: recording.id, syncState: 'queued' as const }),
      uploadRecordingAudio: async () => { calls.push('raw:complete'); return { objectKey: 'raw-key' }; },
      uploadRecordingAnalysisAudio: async () => { throw new Error('analysis upload unavailable'); }
    } as unknown as ApiClient;

    const result = await uploadPendingAudio(client);

    expect(result.uploaded).toBe(1);
    expect(result.failures).toEqual([{ id: recording.id, message: 'analysis upload unavailable' }]);
    expect(calls).toContain('raw:complete');
    expect(calls).toContain('sidecar:error');
    expect(calls).not.toContain('raw:error');
  });
});
