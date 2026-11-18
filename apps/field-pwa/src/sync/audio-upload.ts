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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The S3 audio upload failed.';
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
export async function uploadPendingAudio(client: ApiClient): Promise<AudioUploadBatchResult> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { attempted: 0, uploaded: 0, failures: [] };
  }

  const pending = (await recordingStore.listUploadQueue())
    .filter((recording) => recording.metadataRegistrationState === 'registered');
  if (!pending.length) return { attempted: 0, uploaded: 0, failures: [] };
  let health;
  try {
    health = await client.getHealth();
  } catch {
    return { attempted: 0, uploaded: 0, failures: [] };
  }
  if (health.runtime.uploads !== 'configured') return { attempted: 0, uploaded: 0, failures: [] };
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
      const target = await client.createRecordingUploadUrl(recording.id);
      objectKey = target.objectKey;
      await recordingStore.setSyncState(recording.id, 'uploading', {
        objectKey,
        incrementAttempt: true
      });

      const response = await fetch(target.url, {
        method: 'PUT',
        headers: { 'Content-Type': recording.mimeType },
        body: file
      });
      if (!response.ok) throw new Error(`S3 returned HTTP ${response.status} for the audio upload.`);

      await client.completeRecordingUpload(recording.id);
      await recordingStore.setSyncState(recording.id, 'uploaded', { objectKey });
      uploaded += 1;
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
    }
  }

  return { attempted: pending.length, uploaded, failures };
}
