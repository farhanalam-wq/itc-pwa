import { ApiClientError, type ApiClient, type VisitRecord } from '@itc/api-client';
import type { RecordingMetadata } from '@itc/domain';
import { recordingStore } from '../storage/recording-store';
import type { LocalRecording } from '../storage/indexed-db';

export interface MetadataRegistrationResult {
  visit: VisitRecord;
  recording: RecordingMetadata;
}

export interface MetadataRegistrationFailure {
  id: string;
  message: string;
  retryable: boolean;
}

export interface MetadataRegistrationBatchResult {
  online: boolean;
  attempted: number;
  registered: number;
  failures: MetadataRegistrationFailure[];
}

export interface MetadataRegistrationSyncController {
  process(): Promise<MetadataRegistrationBatchResult>;
  stop(): void;
}

function assertRegistrationReady(recording: LocalRecording): void {
  if (recording.localState !== 'ready') {
    throw new Error('Finalize the local audio before registering visit metadata.');
  }
  if (!recording.consentRecordedAt) {
    throw new Error('Recorded consent is required before registering visit metadata.');
  }
}

function visitRequest(recording: LocalRecording) {
  return {
    id: recording.visitId,
    outletName: recording.outletName,
    representativeId: recording.representativeId,
    territoryId: recording.territoryId,
    consentRecordedAt: recording.consentRecordedAt!
  };
}

function recordingRequest(recording: LocalRecording) {
  return {
    id: recording.id,
    startedAt: recording.startedAt,
    durationSeconds: recording.durationSeconds,
    mimeType: recording.mimeType,
    byteLength: recording.byteLength
  };
}

function retryableError(error: unknown): boolean {
  return error instanceof ApiClientError ? error.retryable : true;
}

export async function registerFinalizedMetadata(
  recordingId: string,
  client: ApiClient
): Promise<MetadataRegistrationResult> {
  const localRecording = await recordingStore.get(recordingId);
  if (!localRecording) throw new Error('Local recording metadata was not found: ' + recordingId);
  assertRegistrationReady(localRecording);

  await recordingStore.setMetadataRegistrationState(recordingId, 'registering');
  try {
    // Both IDs and request bodies are persisted locally, so a retry after a
    // lost response replays the exact idempotent API operations.
    const visit = await client.createVisit(visitRequest(localRecording));
    const recording = await client.createVisitRecording(
      localRecording.visitId,
      recordingRequest(localRecording)
    );
    await recordingStore.setMetadataRegistrationState(recordingId, 'registered');
    // Metadata registration does not upload bytes; keep the audio state queued.
    return { visit, recording };
  } catch (error) {
    await recordingStore.setMetadataRegistrationState(
      recordingId,
      'error',
      error instanceof Error ? error.message : 'Metadata registration failed.',
      retryableError(error)
    ).catch(() => undefined);
    throw error;
  }
}

/**
 * Process the durable metadata queue when the app starts or returns online.
 * Replays pending registrations by stable ID after interruptions.
 */
export async function registerPendingMetadata(
  client: ApiClient
): Promise<MetadataRegistrationBatchResult> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { online: false, attempted: 0, registered: 0, failures: [] };
  }

  const pending = await recordingStore.listMetadataRegistrationQueue();
  const failures: MetadataRegistrationFailure[] = [];
  let registered = 0;

  for (const recording of pending) {
    try {
      await registerFinalizedMetadata(recording.id, client);
      registered += 1;
    } catch (error) {
      failures.push({
        id: recording.id,
        message: error instanceof Error ? error.message : 'Metadata registration failed.',
        retryable: retryableError(error)
      });
    }
  }

  return { online: true, attempted: pending.length, registered, failures };
}

/** Process the queue on startup and each time browser connectivity returns. */
export function startMetadataRegistrationSync(
  client: ApiClient,
  afterMetadataRegistration?: () => Promise<unknown>
): MetadataRegistrationSyncController {
  let activeProcess: Promise<MetadataRegistrationBatchResult> | undefined;
  const process = () => {
    if (activeProcess) return activeProcess;
    activeProcess = (async () => {
      const result = await registerPendingMetadata(client);
      await afterMetadataRegistration?.();
      return result;
    })().finally(() => { activeProcess = undefined; });
    return activeProcess;
  };
  const onOnline = () => { void process().catch(() => undefined); };

  if (typeof window !== 'undefined') {
    window.addEventListener('online', onOnline);
    onOnline();
  }

  return {
    process,
    stop: () => {
      if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
    }
  };
}
