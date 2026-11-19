import { ApiClientError, type ApiClient } from '@itc/api-client';
import { recordingStore } from '../storage/recording-store';

export interface AudioUploadFailure {
  id: string;
  message: string;
}

export interface AudioUploadBatchResult {
  attempted: number;
  uploaded: number;
  failures: AudioUploadFailure[];
}

export interface ChunkUploadProgress {
  recordingId: string;
  outletName: string;
  completedChunks: number;
  totalChunks: number;
  state: 'uploading' | 'complete' | 'error';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The conversation audio upload failed.';
}

function isRetryable(error: unknown): boolean {
  if (error instanceof ApiClientError) return error.retryable && error.code !== 's3_not_configured';
  if (!(error instanceof Error)) return true;
  if (error.message.includes('local audio file size')) return false;
  const httpStatus = /HTTP (\d+)/.exec(error.message)?.[1];
  if (!httpStatus) return true;
  const status = Number(httpStatus);
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Upload finalized, consented OPFS files after their visit metadata is linked. */
export async function uploadPendingAudio(client: ApiClient, onProgress?: (progress: ChunkUploadProgress) => void): Promise<AudioUploadBatchResult> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { attempted: 0, uploaded: 0, failures: [] };
  }

  const pending = (await recordingStore.listUploadQueue())
    .filter((recording) => recording.metadataRegistrationState === 'registered');
  if (!pending.length) return { attempted: 0, uploaded: 0, failures: [] };
  const failures: AudioUploadFailure[] = [];
  let uploaded = 0;

  for (const recording of pending) {
    let objectKey: string | undefined;
    try {
      const remote = await client.getRecording(recording.id);
      if (remote.syncState === 'uploaded') {
        await recordingStore.setSyncState(recording.id, 'uploaded', { objectKey: remote.objectKey });
        uploaded += 1;
        continue;
      }
      const file = await recordingStore.readAudio(recording.id);
      if (file.size !== recording.byteLength) {
        throw new Error('The local audio file size no longer matches its saved recording details.');
      }
      await recordingStore.setSyncState(recording.id, 'uploading', {
        incrementAttempt: true
      });
      const totalChunks = Math.max(1, Math.ceil(file.size / (1024 * 1024)));
      onProgress?.({ recordingId: recording.id, outletName: recording.outletName, completedChunks: 0, totalChunks, state: 'uploading' });
      const stored = await client.uploadRecordingAudio(recording.id, file, (completedChunks, total) => {
        onProgress?.({ recordingId: recording.id, outletName: recording.outletName, completedChunks, totalChunks: total, state: 'uploading' });
      });
      objectKey = stored.objectKey;
      await recordingStore.setSyncState(recording.id, 'uploaded', { objectKey });
      uploaded += 1;
      onProgress?.({ recordingId: recording.id, outletName: recording.outletName, completedChunks: totalChunks, totalChunks, state: 'complete' });
    } catch (error) {
      await recordingStore.setSyncState(recording.id, 'error', {
        objectKey,
        error: errorMessage(error),
        retryable: isRetryable(error)
      }).catch(() => undefined);
      failures.push({
        id: recording.id,
        message: error instanceof ApiClientError && error.status === 503
          ? error.message
          : errorMessage(error)
      });
      onProgress?.({ recordingId: recording.id, outletName: recording.outletName, completedChunks: 0, totalChunks: Math.max(1, Math.ceil(recording.byteLength / (1024 * 1024))), state: 'error' });
    }
  }

  return { attempted: pending.length, uploaded, failures };
}
