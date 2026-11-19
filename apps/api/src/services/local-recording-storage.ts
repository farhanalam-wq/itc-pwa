import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const RECORDING_UPLOAD_CHUNK_BYTES = 1024 * 1024;

interface ChunkEntry {
  byteLength: number;
  sha256: string;
}

interface UploadManifest {
  id: string;
  startedAt: string;
  mimeType: string;
  expectedByteLength: number;
  total: number;
  chunks: Record<string, ChunkEntry>;
}

export class UploadStagingError extends Error {
  constructor(message: string, readonly code: 'upload_conflict' | 'upload_incomplete' | 'upload_invalid') {
    super(message);
    this.name = 'UploadStagingError';
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function expectedChunkBytes(index: number, expectedByteLength: number): number {
  return Math.min(RECORDING_UPLOAD_CHUNK_BYTES, expectedByteLength - index * RECORDING_UPLOAD_CHUNK_BYTES);
}

export class LocalRecordingStorage {
  readonly root: string;
  private readonly uploadLocks = new Map<string, Promise<void>>();

  constructor(root = resolve(Bun.env.LOCAL_UPLOAD_STAGING_DIR ?? './var/upload-staging')) {
    this.root = resolve(root);
  }

  async save(input: { id: string; startedAt: string; mimeType: string; bytes: Uint8Array }): Promise<string> {
    const { path, relative } = this.recordingPath(input.id, input.startedAt, input.mimeType);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, input.bytes);
    return `local-recordings/${relative}`;
  }

  keyFor(id: string, startedAt: string, mimeType: string): string {
    return `local-recordings/${this.recordingPath(id, startedAt, mimeType).relative}`;
  }

  async removeStaged(id: string, startedAt: string, mimeType: string): Promise<void> {
    const { path } = this.recordingPath(id, startedAt, mimeType);
    await rm(path, { force: true });
    await rm(`${path}.chunks`, { recursive: true, force: true });
  }

  async saveChunk(input: {
    id: string;
    startedAt: string;
    mimeType: string;
    index: number;
    total: number;
    expectedByteLength: number;
    bytes: Uint8Array;
  }): Promise<{ objectKey: string; complete: boolean }> {
    return this.withUploadLock(input.id, async () => {
      if (!Number.isInteger(input.total) || input.total < 1
        || !Number.isInteger(input.index) || input.index < 0 || input.index >= input.total
        || !Number.isInteger(input.expectedByteLength) || input.expectedByteLength < 1) {
        throw new UploadStagingError('The audio chunk details are invalid.', 'upload_invalid');
      }
      const requiredTotal = Math.ceil(input.expectedByteLength / RECORDING_UPLOAD_CHUNK_BYTES);
      if (input.total !== requiredTotal || input.bytes.byteLength !== expectedChunkBytes(input.index, input.expectedByteLength)) {
        throw new UploadStagingError('The audio chunk size or count does not match the registered recording.', 'upload_invalid');
      }

      const { path, relative } = this.recordingPath(input.id, input.startedAt, input.mimeType);
      const chunkDir = `${path}.chunks`;
      const manifestPath = join(chunkDir, 'manifest.json');
      await mkdir(chunkDir, { recursive: true });

      const existingManifest = await this.readManifest(manifestPath);
      const manifest: UploadManifest = existingManifest ?? {
        id: input.id,
        startedAt: input.startedAt,
        mimeType: input.mimeType,
        expectedByteLength: input.expectedByteLength,
        total: input.total,
        chunks: {}
      };
      if (manifest.id !== input.id || manifest.startedAt !== input.startedAt
        || manifest.mimeType !== input.mimeType || manifest.expectedByteLength !== input.expectedByteLength
        || manifest.total !== input.total) {
        throw new UploadStagingError('This recording upload was already started with different audio details.', 'upload_conflict');
      }

      const indexKey = String(input.index);
      const nextEntry: ChunkEntry = { byteLength: input.bytes.byteLength, sha256: sha256(input.bytes) };
      const previousEntry = manifest.chunks[indexKey];
      const partPath = join(chunkDir, `${String(input.index).padStart(6, '0')}.part`);
      if (previousEntry && (previousEntry.byteLength !== nextEntry.byteLength || previousEntry.sha256 !== nextEntry.sha256)) {
        throw new UploadStagingError('A retry supplied different audio for a chunk that was already received.', 'upload_conflict');
      }

      const partExists = await Bun.file(partPath).exists();
      if (partExists) {
        const savedBytes = new Uint8Array(await readFile(partPath));
        if (savedBytes.byteLength !== nextEntry.byteLength || sha256(savedBytes) !== nextEntry.sha256) {
          if (previousEntry) throw new UploadStagingError('The saved audio chunk does not match its upload record.', 'upload_conflict');
          await this.writeAtomically(partPath, input.bytes);
        }
      } else {
        await this.writeAtomically(partPath, input.bytes);
      }

      manifest.chunks[indexKey] = nextEntry;
      await this.writeAtomically(manifestPath, Buffer.from(JSON.stringify(manifest)));
      const complete = Object.keys(manifest.chunks).length === manifest.total;
      return { objectKey: `local-recordings/${relative}`, complete };
    });
  }

  async assemble(input: {
    id: string;
    startedAt: string;
    mimeType: string;
    expectedByteLength: number;
  }): Promise<Uint8Array> {
    return this.withUploadLock(input.id, async () => {
      const { path } = this.recordingPath(input.id, input.startedAt, input.mimeType);
      const chunkDir = `${path}.chunks`;
      const manifest = await this.readManifest(join(chunkDir, 'manifest.json'));
      const expectedTotal = Math.ceil(input.expectedByteLength / RECORDING_UPLOAD_CHUNK_BYTES);
      if (!manifest || manifest.id !== input.id || manifest.startedAt !== input.startedAt
        || manifest.mimeType !== input.mimeType || manifest.expectedByteLength !== input.expectedByteLength
        || manifest.total !== expectedTotal || Object.keys(manifest.chunks).length !== expectedTotal) {
        throw new UploadStagingError('The full conversation audio has not reached the API yet.', 'upload_incomplete');
      }

      const chunks: Buffer[] = [];
      for (let index = 0; index < expectedTotal; index += 1) {
        const indexKey = String(index);
        const entry = manifest.chunks[indexKey];
        if (!entry) throw new UploadStagingError('One or more audio chunks are missing. Retry the upload.', 'upload_incomplete');
        const part = await readFile(join(chunkDir, `${String(index).padStart(6, '0')}.part`));
        if (part.byteLength !== entry.byteLength || sha256(part) !== entry.sha256
          || part.byteLength !== expectedChunkBytes(index, input.expectedByteLength)) {
          throw new UploadStagingError('An audio chunk failed its integrity check. Retry the upload.', 'upload_conflict');
        }
        chunks.push(part);
      }

      const audio = Buffer.concat(chunks, input.expectedByteLength);
      if (audio.byteLength !== input.expectedByteLength) {
        throw new UploadStagingError('The assembled conversation audio does not match the registered size.', 'upload_conflict');
      }
      return audio;
    });
  }

  private async readManifest(path: string): Promise<UploadManifest | undefined> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as UploadManifest;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
      throw new UploadStagingError('The server could not read the audio upload record.', 'upload_conflict');
    }
  }

  private async writeAtomically(path: string, bytes: Uint8Array): Promise<void> {
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, bytes);
    await rename(temporary, path);
  }

  private async withUploadLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.uploadLocks.get(id) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const chain = previous.then(() => gate);
    this.uploadLocks.set(id, chain);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.uploadLocks.get(id) === chain) this.uploadLocks.delete(id);
    }
  }

  private recordingPath(id: string, startedAt: string, mimeType: string) {
    const date = new Date(startedAt);
    if (Number.isNaN(date.getTime())) throw new UploadStagingError('Recording start time is invalid.', 'upload_invalid');
    const parts = [
      String(date.getUTCFullYear()),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      String(date.getUTCDate()).padStart(2, '0')
    ];
    const extension = mimeType.split('/')[1]?.split(';')[0]?.replace(/[^a-z0-9]/gi, '') || 'audio';
    const relative = [...parts, `${encodeURIComponent(id)}.${extension}`].join('/');
    return { relative, path: join(this.root, relative) };
  }
}
