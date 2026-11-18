import type { AnalysisState, SyncState } from '@itc/domain';
import {
  addLocalRecording,
  deleteLocalRecording,
  getLocalRecording,
  listLocalRecordings,
  updateLocalRecording,
  type LocalRecording,
  type MetadataRegistrationState
} from './indexed-db';
import {
  audioFileName,
  fileExists,
  getAudioFile,
  getRecordingDirectory,
  getStorageEstimate,
  removeAudioFile,
  requestPersistentStorage
} from './opfs';

export interface StartRecordingInput {
  id?: string;
  visitId?: string;
  outletId?: string;
  outletName: string;
  representativeId: string;
  territoryId: string;
  mimeType: string;
  consentRecordedAt: string;
  startedAt?: string;
}

export interface RecoveryItem {
  id: string;
  outcome: 'incomplete' | 'missing_file' | 'unreadable';
  byteLength?: number;
  message: string;
}

export interface RecoveryReport {
  items: RecoveryItem[];
  incompleteCount: number;
  missingCount: number;
  unreadableCount: number;
}

export interface StorageSnapshot {
  quota?: number;
  usage?: number;
  persistent: boolean;
}

const RFC3339_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function createId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'rec-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function byteLengthOf(chunk: Blob | ArrayBuffer | ArrayBufferView): number {
  if (chunk instanceof Blob) return chunk.size;
  if (chunk instanceof ArrayBuffer) return chunk.byteLength;
  return chunk.byteLength;
}

function fileWriteChunk(chunk: Blob | ArrayBuffer | ArrayBufferView): Blob | ArrayBuffer | Uint8Array<ArrayBuffer> {
  if (chunk instanceof Blob || chunk instanceof ArrayBuffer) return chunk;
  const bytes = new Uint8Array(new ArrayBuffer(chunk.byteLength));
  bytes.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  return bytes;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class RecordingWriter {
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;
  private writtenBytes = 0;

  constructor(
    readonly recording: LocalRecording,
    private readonly fileHandle: FileSystemFileHandle,
    private readonly onFinalize: (id: string, durationSeconds: number) => Promise<LocalRecording>
  ) {}

  append(chunk: Blob | ArrayBuffer | ArrayBufferView): Promise<void> {
    if (this.closed) return Promise.reject(new Error('The recording writer is already closed.'));
    if (byteLengthOf(chunk) === 0) return this.writeChain;

    this.writeChain = this.writeChain.then(async () => {
      const existingFile = await this.fileHandle.getFile();
      const writable = await this.fileHandle.createWritable({ keepExistingData: true });
      try {
        await writable.seek(existingFile.size);
        await writable.write(fileWriteChunk(chunk));
        await writable.close();
        this.writtenBytes = existingFile.size + byteLengthOf(chunk);
      } catch (error) {
        await writable.abort().catch(() => undefined);
        throw error;
      }
    });
    return this.writeChain;
  }

  async finalize(durationSeconds: number): Promise<LocalRecording> {
    if (this.closed) throw new Error('The recording writer is already closed.');
    this.closed = true;
    await this.writeChain;
    return this.onFinalize(this.recording.id, Math.max(0, durationSeconds));
  }

  discard(): void {
    this.closed = true;
  }

  get bytesWritten(): number {
    return this.writtenBytes;
  }
}

export class RecordingStore {
  async create(input: StartRecordingInput): Promise<RecordingWriter> {
    if (!RFC3339_DATE_TIME.test(input.consentRecordedAt)
      || !Number.isFinite(Date.parse(input.consentRecordedAt))) {
      throw new Error('A valid consent timestamp is required before recording can be started.');
    }
    const id = input.id ?? createId();
    const visitId = input.visitId ?? createId();
    const fileName = audioFileName(id, input.mimeType);
    const createdAt = input.startedAt ?? nowIso();

    const recording: LocalRecording = {
      id,
      visitId,
      outletId: input.outletId,
      outletName: input.outletName,
      representativeId: input.representativeId,
      territoryId: input.territoryId,
      consentRecordedAt: input.consentRecordedAt,
      startedAt: createdAt,
      durationSeconds: 0,
      mimeType: input.mimeType,
      byteLength: 0,
      syncState: 'queued',
      analysisState: 'not_started',
      fileName,
      localState: 'recording',
      metadataRegistrationState: 'not_ready',
      updatedAt: createdAt,
      uploadAttempts: 0
    };

    let fileHandle: FileSystemFileHandle;
    let metadataReserved = false;
    try {
      if (await fileExists(fileName)) {
        throw new Error('An unindexed audio file already uses this recording ID.');
      }
      const directory = await getRecordingDirectory();
      await addLocalRecording(recording);
      metadataReserved = true;
      // Recheck after reserving the metadata ID to catch another tab creating
      // the same path between the first check and the reservation.
      if (await fileExists(fileName)) {
        await deleteLocalRecording(id);
        throw new Error('An audio file was created concurrently for this recording ID.');
      }
      fileHandle = await directory.getFileHandle(fileName, { create: true });
    } catch (error) {
      // A recording that never obtained its own OPFS file has no audio to
      // recover. Remove only the metadata reservation; never touch a colliding
      // file because it may belong to another recording.
      if (metadataReserved) await deleteLocalRecording(id).catch(() => undefined);
      throw error;
    }

    return new RecordingWriter(recording, fileHandle, async (recordingId, durationSeconds) => {
      const file = await fileHandle.getFile();
      return updateLocalRecording(recordingId, (current) => ({
        ...current,
        durationSeconds,
        byteLength: file.size,
        localState: 'ready',
        metadataRegistrationState: current.consentRecordedAt ? 'queued' : 'not_ready',
        metadataRegistrationError: undefined,
        syncState: 'queued',
        analysisState: 'not_started',
        completedAt: nowIso(),
        updatedAt: nowIso(),
        incompleteReason: undefined,
        lastSyncError: undefined
      }));
    });
  }

  get(id: string): Promise<LocalRecording | undefined> {
    return getLocalRecording(id);
  }

  async list(): Promise<LocalRecording[]> {
    const records = await listLocalRecordings();
    return records.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async listUploadQueue(): Promise<LocalRecording[]> {
    const records = await listLocalRecordings();
    return records
      .filter((record) => record.localState === 'ready' && record.syncState === 'queued')
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  async listMetadataRegistrationQueue(): Promise<LocalRecording[]> {
    const records = await listLocalRecordings();
    return records
      .filter((record) => record.localState === 'ready' && Boolean(record.consentRecordedAt))
      .filter((record) => record.metadataRegistrationState === 'queued'
        || record.metadataRegistrationState === 'registering'
        || record.metadataRegistrationState === 'registered'
        || (record.metadataRegistrationState === 'error' && record.metadataRegistrationRetryable !== false))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  async setMetadataRegistrationState(
    id: string,
    metadataRegistrationState: MetadataRegistrationState,
    error?: string,
    retryable = false
  ): Promise<LocalRecording> {
    return updateLocalRecording(id, (recording) => {
      if (metadataRegistrationState !== 'not_ready' && recording.localState !== 'ready') {
        throw new Error('Only finalized local recordings can be registered with the API.');
      }
      if (metadataRegistrationState !== 'not_ready' && !recording.consentRecordedAt) {
        throw new Error('Consent must be recorded before metadata registration.');
      }
      return {
        ...recording,
        metadataRegistrationState,
        metadataRegistrationError: metadataRegistrationState === 'error' ? error ?? 'Metadata registration failed.' : undefined,
        metadataRegistrationRetryable: metadataRegistrationState === 'error' ? retryable : undefined,
        updatedAt: nowIso()
      };
    });
  }

  async retryMetadataRegistration(id: string): Promise<LocalRecording> {
    return this.setMetadataRegistrationState(id, 'queued');
  }

  async readAudio(id: string): Promise<File> {
    const recording = await getLocalRecording(id);
    if (!recording) throw new Error('Recording metadata was not found: ' + id);
    return getAudioFile(recording.fileName);
  }

  async setSyncState(
    id: string,
    syncState: SyncState,
    options: { objectKey?: string; error?: string; incrementAttempt?: boolean } = {}
  ): Promise<LocalRecording> {
    return updateLocalRecording(id, (recording) => {
      if (recording.localState !== 'ready') {
        throw new Error('Only finalized local recordings can enter the upload state machine.');
      }
      return {
        ...recording,
        syncState,
        objectKey: options.objectKey ?? recording.objectKey,
        uploadAttempts: recording.uploadAttempts + (options.incrementAttempt ? 1 : 0),
        lastSyncError: syncState === 'error' ? options.error ?? 'Upload failed.' : undefined,
        updatedAt: nowIso()
      };
    });
  }

  async setAnalysisState(id: string, analysisState: AnalysisState): Promise<LocalRecording> {
    return updateLocalRecording(id, (recording) => ({
      ...recording,
      analysisState,
      updatedAt: nowIso()
    }));
  }

  async retryUpload(id: string): Promise<LocalRecording> {
    return updateLocalRecording(id, (recording) => {
      if (recording.localState !== 'ready') {
        throw new Error('Only a finalized recording can be retried.');
      }
      return {
        ...recording,
        syncState: 'queued',
        lastSyncError: undefined,
        updatedAt: nowIso()
      };
    });
  }

  async delete(id: string): Promise<void> {
    const recording = await getLocalRecording(id);
    if (!recording) return;
    try {
      await removeAudioFile(recording.fileName);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
    }
    await deleteLocalRecording(id);
  }

  async finalizeRecovered(id: string, durationSeconds: number): Promise<LocalRecording> {
    const recording = await getLocalRecording(id);
    if (!recording || recording.localState !== 'incomplete') {
      throw new Error('Only a recovered incomplete recording can be finalized.');
    }
    const file = await getAudioFile(recording.fileName);
    if (file.size === 0) throw new Error('The incomplete recording has no saved audio to finalize.');
    return updateLocalRecording(id, (current) => ({
      ...current,
      durationSeconds: Math.max(0, durationSeconds),
      byteLength: file.size,
      localState: 'ready',
      metadataRegistrationState: current.consentRecordedAt ? 'queued' : 'not_ready',
      metadataRegistrationError: undefined,
      syncState: 'queued',
      analysisState: 'not_started',
      completedAt: nowIso(),
      incompleteReason: undefined,
      lastSyncError: undefined,
      updatedAt: nowIso()
    }));
  }

  async recoverInterrupted(): Promise<RecoveryReport> {
    const interrupted = (await listLocalRecordings()).filter((record) => record.localState === 'recording');
    const items: RecoveryItem[] = [];

    for (const recording of interrupted) {
      try {
        if (!(await fileExists(recording.fileName))) {
          await updateLocalRecording(recording.id, (current) => ({
            ...current,
            localState: 'incomplete',
            syncState: 'error',
            incompleteReason: 'Audio file is missing from local storage.',
            lastSyncError: undefined,
            updatedAt: nowIso()
          }));
          items.push({
            id: recording.id,
            outcome: 'missing_file',
            message: 'Metadata exists but the audio file is missing. This item was kept for review and will not be uploaded.'
          });
          continue;
        }

        const file = await getAudioFile(recording.fileName);
        const message = file.size > 0
          ? 'Recording was interrupted before finalization. Audio was preserved locally and is not queued for upload.'
          : 'Recording was interrupted before any audio was saved. The empty file was preserved for review.';

        await updateLocalRecording(recording.id, (current) => ({
          ...current,
          localState: 'incomplete',
          byteLength: file.size,
          syncState: 'error',
          incompleteReason: message,
          updatedAt: nowIso()
        }));
        items.push({ id: recording.id, outcome: 'incomplete', byteLength: file.size, message });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not inspect the saved audio file.';
        await updateLocalRecording(recording.id, (current) => ({
          ...current,
          localState: 'incomplete',
          syncState: 'error',
          incompleteReason: message,
          updatedAt: nowIso()
        })).catch(() => undefined);
        items.push({ id: recording.id, outcome: 'unreadable', message });
      }
    }

    return {
      items,
      incompleteCount: items.filter((item) => item.outcome === 'incomplete').length,
      missingCount: items.filter((item) => item.outcome === 'missing_file').length,
      unreadableCount: items.filter((item) => item.outcome === 'unreadable').length
    };
  }

  async requestDurability(): Promise<boolean> {
    return requestPersistentStorage();
  }

  async storageSnapshot(): Promise<StorageSnapshot> {
    const estimate = await getStorageEstimate();
    const persistent = typeof navigator !== 'undefined' && navigator.storage?.persisted
      ? await navigator.storage.persisted()
      : false;
    return {
      quota: estimate?.quota,
      usage: estimate?.usage,
      persistent
    };
  }
}

export const recordingStore = new RecordingStore();
