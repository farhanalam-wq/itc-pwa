import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export class LocalRecordingStorage {
  readonly root: string;

  constructor(root = resolve(Bun.env.LOCAL_RECORDING_DIR ?? 'uploads/recordings')) {
    this.root = root;
  }

  async save(input: { id: string; startedAt: string; mimeType: string; bytes: Uint8Array }): Promise<string> {
    const date = new Date(input.startedAt);
    const parts = Number.isNaN(date.getTime()) ? ['unknown', 'unknown', 'unknown'] : [
      String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0')
    ];
    const extension = input.mimeType.split('/')[1]?.split(';')[0]?.replace(/[^a-z0-9]/gi, '') || 'audio';
    const relative = [...parts, `${encodeURIComponent(input.id)}.${extension}`].join('/');
    const path = join(this.root, relative);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, input.bytes);
    return `local-recordings/${relative}`;
  }

  keyFor(id: string, startedAt: string, mimeType: string): string {
    return `local-recordings/${this.recordingPath(id, startedAt, mimeType).relative}`;
  }

  read(id: string, startedAt: string, mimeType: string): Promise<Buffer> {
    return readFile(this.recordingPath(id, startedAt, mimeType).path);
  }

  async removeStaged(id: string, startedAt: string, mimeType: string): Promise<void> {
    const { path } = this.recordingPath(id, startedAt, mimeType);
    await rm(path, { force: true });
    await rm(`${path}.chunks`, { recursive: true, force: true });
  }

  async saveChunk(input: { id: string; startedAt: string; mimeType: string; index: number; total: number; bytes: Uint8Array }): Promise<{ objectKey: string; complete: boolean }> {
    const { path, relative } = this.recordingPath(input.id, input.startedAt, input.mimeType);
    const chunkDir = `${path}.chunks`;
    await mkdir(chunkDir, { recursive: true });
    await writeFile(join(chunkDir, `${String(input.index).padStart(6, '0')}.part`), input.bytes);
    if (input.index + 1 < input.total) return { objectKey: `local-recordings/${relative}`, complete: false };
    const chunks = await Promise.all(Array.from({ length: input.total }, (_, index) => readFile(join(chunkDir, `${String(index).padStart(6, '0')}.part`))));
    await Bun.write(path, Buffer.concat(chunks));
    await rm(chunkDir, { recursive: true, force: true });
    return { objectKey: `local-recordings/${relative}`, complete: true };
  }

  private recordingPath(id: string, startedAt: string, mimeType: string) {
    const date = new Date(startedAt);
    const parts = Number.isNaN(date.getTime()) ? ['unknown', 'unknown', 'unknown'] : [
      String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0')
    ];
    const extension = mimeType.split('/')[1]?.split(';')[0]?.replace(/[^a-z0-9]/gi, '') || 'audio';
    const relative = [...parts, `${encodeURIComponent(id)}.${extension}`].join('/');
    return { relative, path: join(this.root, relative) };
  }
}
