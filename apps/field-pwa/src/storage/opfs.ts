const STORAGE_DIRECTORY = 'recordings';

export interface OpfsSupport {
  supported: boolean;
  reason?: string;
}

export function getOpfsSupport(): OpfsSupport {
  if (typeof navigator === 'undefined' || !navigator.storage) {
    return { supported: false, reason: 'Browser storage APIs are not available.' };
  }
  if (typeof navigator.storage.getDirectory !== 'function') {
    return { supported: false, reason: 'This browser does not support the Origin Private File System.' };
  }
  if (typeof indexedDB === 'undefined') {
    return { supported: false, reason: 'This browser does not support IndexedDB.' };
  }
  return { supported: true };
}

export async function getRecordingDirectory(): Promise<FileSystemDirectoryHandle> {
  const support = getOpfsSupport();
  if (!support.supported) {
    throw new Error(support.reason ?? 'Durable recording storage is unavailable.');
  }

  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(STORAGE_DIRECTORY, { create: true });
}

export function audioFileName(id: string, mimeType: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  const subtype = mimeType.split(';')[0]?.split('/')[1]?.toLowerCase();
  const extension = subtype === 'webm' ? 'webm'
    : subtype === 'mp4' ? 'm4a'
      : subtype === 'ogg' ? 'ogg'
        : subtype === 'wav' || subtype === 'wave' ? 'wav'
          : 'audio';
  return safeId + '.' + extension;
}

export async function getAudioFile(fileName: string): Promise<File> {
  const directory = await getRecordingDirectory();
  const handle = await directory.getFileHandle(fileName);
  return handle.getFile();
}

export async function removeAudioFile(fileName: string): Promise<void> {
  const directory = await getRecordingDirectory();
  await directory.removeEntry(fileName);
}

export async function fileExists(fileName: string): Promise<boolean> {
  try {
    await getAudioFile(fileName);
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return false;
    throw error;
  }
}

export async function getStorageEstimate(): Promise<StorageEstimate | undefined> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return undefined;
  return navigator.storage.estimate();
}

export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  return navigator.storage.persist();
}
