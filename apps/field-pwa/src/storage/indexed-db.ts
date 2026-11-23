import type { DenoisingState, RecordingMetadata, SyncState } from '@itc/domain';

export type LocalRecordingState = 'recording' | 'incomplete' | 'ready';
export type MetadataRegistrationState = 'not_ready' | 'queued' | 'registering' | 'registered' | 'error';
export type DenoisedAudioState = DenoisingState;

export interface LocalRecording extends RecordingMetadata {
  visitId: string;
  consentRecordedAt?: string;
  metadataRegistrationState: MetadataRegistrationState;
  metadataRegistrationError?: string;
  metadataRegistrationRetryable?: boolean;
  fileName: string;
  localState: LocalRecordingState;
  updatedAt: string;
  completedAt?: string;
  uploadAttempts: number;
  uploadRetryable?: boolean;
  lastSyncError?: string;
  incompleteReason?: string;
  denoisedAudioState?: DenoisedAudioState;
  denoisedAudioFileName?: string;
  denoisedAudioByteLength?: number;
  denoisedAudioMimeType?: string;
  denoisedAudioError?: string;
  denoisedAudioErrorCode?: string;
  denoisedAudioSyncState?: SyncState;
  denoisedAudioRetryable?: boolean;
}

const DB_NAME = 'itc-field-source';
const DB_VERSION = 3;
const RECORDINGS_STORE = 'recordings';

let databasePromise: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is not available in this browser.'));
  }

  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const database = request.result;
      let store: IDBObjectStore;
      if (!database.objectStoreNames.contains(RECORDINGS_STORE)) {
        store = database.createObjectStore(RECORDINGS_STORE, { keyPath: 'id' });
        store.createIndex('syncState', 'syncState', { unique: false });
        store.createIndex('localState', 'localState', { unique: false });
        store.createIndex('startedAt', 'startedAt', { unique: false });
      } else {
        store = request.transaction!.objectStore(RECORDINGS_STORE);
      }

      if (!store.indexNames.contains('metadataRegistrationState')) {
        store.createIndex('metadataRegistrationState', 'metadataRegistrationState', { unique: false });
      }

      if (event.oldVersion < 3) {
        const cursorRequest = store.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const oldRecording = cursor.value as Partial<LocalRecording>;
          cursor.update({
            ...oldRecording,
            visitId: oldRecording.visitId ?? oldRecording.id,
            metadataRegistrationState: oldRecording.metadataRegistrationState ?? 'not_ready',
            denoisedAudioState: oldRecording.denoisedAudioState ?? 'not_started'
          });
          cursor.continue();
        };
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = undefined;
      };
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = undefined;
      reject(request.error ?? new Error('Could not open the local recording database.'));
    };
    request.onblocked = () => {
      databasePromise = undefined;
      reject(new Error('The local recording database is blocked by another open tab.'));
    };
  });

  return databasePromise;
}

function runTransaction<T>(
  mode: IDBTransactionMode,
  requestFactory: (store: IDBObjectStore, transaction: IDBTransaction) => IDBRequest<T>
): Promise<T> {
  return openDatabase().then((database) => new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(RECORDINGS_STORE, mode);
    let request: IDBRequest<T>;
    let result: T;
    let requestFailed = false;

    try {
      request = requestFactory(transaction.objectStore(RECORDINGS_STORE), transaction);
    } catch (error) {
      transaction.abort();
      reject(error);
      return;
    }

    request.onsuccess = () => {
      result = request.result;
    };
    request.onerror = () => {
      requestFailed = true;
      reject(request.error ?? new Error('The local recording database request failed.'));
    };
    transaction.oncomplete = () => {
      if (!requestFailed) resolve(result);
    };
    transaction.onabort = () => {
      if (!requestFailed) reject(transaction.error ?? new Error('The local recording database transaction was aborted.'));
    };
    transaction.onerror = () => {
      if (!requestFailed) reject(transaction.error ?? new Error('The local recording database transaction failed.'));
    };
  }));
}

export function addLocalRecording(recording: LocalRecording): Promise<IDBValidKey> {
  return runTransaction('readwrite', (store) => store.add(recording));
}

export function getLocalRecording(id: string): Promise<LocalRecording | undefined> {
  return runTransaction('readonly', (store) => store.get(id));
}

export function listLocalRecordings(): Promise<LocalRecording[]> {
  return runTransaction('readonly', (store) => store.getAll());
}

export function updateLocalRecording(
  id: string,
  update: (recording: LocalRecording) => LocalRecording
): Promise<LocalRecording> {
  return openDatabase().then((database) => new Promise<LocalRecording>((resolve, reject) => {
    const transaction = database.transaction(RECORDINGS_STORE, 'readwrite');
    const store = transaction.objectStore(RECORDINGS_STORE);
    const read = store.get(id) as IDBRequest<LocalRecording | undefined>;
    let updated: LocalRecording | undefined;

    read.onsuccess = () => {
      if (!read.result) {
        transaction.abort();
        reject(new Error('Recording metadata was not found: ' + id));
        return;
      }
      try {
        updated = update(read.result);
        store.put(updated);
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    };
    read.onerror = () => reject(read.error ?? new Error('Could not read recording metadata.'));
    transaction.oncomplete = () => {
      if (updated) resolve(updated);
    };
    transaction.onabort = () => {
      if (!updated) reject(transaction.error ?? new Error('Recording metadata update was aborted.'));
    };
    transaction.onerror = () => reject(transaction.error ?? new Error('Recording metadata update failed.'));
  }));
}

export function deleteLocalRecording(id: string): Promise<undefined> {
  return runTransaction('readwrite', (store) => store.delete(id));
}
