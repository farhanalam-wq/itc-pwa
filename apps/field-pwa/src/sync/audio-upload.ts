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
  outletName?: string;
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
    let rawAudioAlreadyUploaded = false;
    try {
      const remote = await client.getRecordingSyncStatus(recording.id);
      rawAudioAlreadyUploaded = remote.syncState === 'uploaded';
      if (!rawAudioAlreadyUploaded) {
        const file = await recordingStore.readAudio(recording.id);
        if (file.size !== recording.byteLength) {
          throw new Error('The local audio file size no longer matches its saved recording details.');
        }
        await recordingStore.setSyncState(recording.id, 'uploading', { incrementAttempt: true });
        const totalChunks = Math.max(1, Math.ceil(file.size / (1024 * 1024)));
        onProgress?.({ recordingId: recording.id, outletName: recording.outletName, completedChunks: 0, totalChunks, state: 'uploading' });
        const stored = await client.uploadRecordingAudio(recording.id, file, (completedChunks, total) => {
          onProgress?.({ recordingId: recording.id, outletName: recording.outletName, completedChunks, totalChunks: total, state: 'uploading' });
        });
        objectKey = stored.objectKey;
        await recordingStore.setSyncState(recording.id, 'uploaded', { objectKey });
        onProgress?.({ recordingId: recording.id, outletName: recording.outletName, completedChunks: totalChunks, totalChunks, state: 'complete' });
      } else {
        await recordingStore.setSyncState(recording.id, 'uploaded');
      }
      uploaded += 1;
    } catch (error) {
      const message = errorMessage(error);
      const retryable = isRetryable(error);
      if (!rawAudioAlreadyUploaded) {
        await recordingStore.setSyncState(recording.id, 'error', {
          objectKey,
          error: message,
          retryable
        }).catch(() => undefined);
      }
      failures.push({
        id: recording.id,
        message: error instanceof ApiClientError && error.status === 503
          ? error.message
          : message
      });
      onProgress?.({ recordingId: recording.id, outletName: recording.outletName, completedChunks: 0, totalChunks: Math.max(1, Math.ceil(recording.byteLength / (1024 * 1024))), state: 'error' });
      continue;
    }

    // Raw recording upload remains independent and durable. The server gates
    // Pyannote until this separately stored artifact is complete.
    if (recording.denoisedAudioState === 'ready'
      && recording.denoisedAudioFileName
      && recording.denoisedAudioSyncState !== 'uploaded') {
      let analysisInProgress = false;
      try {
        const analysisFile = await recordingStore.readDenoisedAudio(recording.id);
        if (analysisFile.size !== recording.denoisedAudioByteLength) {
          throw new Error('The local denoised audio size no longer matches its saved analysis details.');
        }
        analysisInProgress = true;
        await recordingStore.setDenoisedAudioSyncState(recording.id, 'uploading');
        const totalChunks = Math.max(1, Math.ceil(analysisFile.size / (1024 * 1024)));
        onProgress?.({ recordingId: recording.id, outletName: recording.outletName, completedChunks: 0, totalChunks, state: 'uploading' });
        const storedAnalysis = await client.uploadRecordingAnalysisAudio(recording.id, analysisFile, (completedChunks, total) => {
          onProgress?.({ recordingId: recording.id, outletName: recording.outletName, completedChunks, totalChunks: total, state: 'uploading' });
        });
        await recordingStore.setDenoisedAudioSyncState(recording.id, 'uploaded', {
          objectKey: storedAnalysis.denoisedAnalysisAudio?.objectKey
        });
        onProgress?.({ recordingId: recording.id, outletName: recording.outletName, completedChunks: totalChunks, totalChunks, state: 'complete' });
      } catch (error) {
        const message = errorMessage(error);
        if (analysisInProgress) {
          await recordingStore.setDenoisedAudioSyncState(recording.id, 'error', {
            error: message,
            retryable: isRetryable(error)
          }).catch(() => undefined);
        } else {
          await recordingStore.markDenoisedAudioUnavailable(
            recording.id,
            message,
            'failed',
            'denoised_sidecar_invalid'
          ).catch(() => undefined);
        }
        failures.push({ id: recording.id, message });
        onProgress?.({ recordingId: recording.id, outletName: recording.outletName, completedChunks: 0, totalChunks: Math.max(1, Math.ceil((recording.denoisedAudioByteLength ?? 0) / (1024 * 1024))), state: 'error' });
      }
    }
  }

  return { attempted: pending.length, uploaded, failures };
}
