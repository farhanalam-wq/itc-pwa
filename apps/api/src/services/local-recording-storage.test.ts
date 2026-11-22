import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRecordingStorage } from './local-recording-storage';

test('stages original and denoised analysis audio independently for the same recording', async () => {
  const root = await mkdtemp(join(tmpdir(), 'itc-audio-artifacts-'));
  try {
    const storage = new LocalRecordingStorage(root);
    const common = { id: 'recording-1', startedAt: '2026-11-22T10:00:00.000Z', mimeType: 'audio/webm', total: 1 };
    const original = new Uint8Array([1, 2, 3, 4]);
    const denoised = new Uint8Array([9, 8, 7]);

    await Promise.all([
      storage.saveChunk({ ...common, index: 0, expectedByteLength: original.length, bytes: original }),
      storage.saveChunk({ ...common, index: 0, expectedByteLength: denoised.length, bytes: denoised, artifact: 'analysis' })
    ]);
    const [assembledOriginal, assembledDenoised] = await Promise.all([
      storage.assemble({ ...common, expectedByteLength: original.length }),
      storage.assemble({ ...common, expectedByteLength: denoised.length, artifact: 'analysis' })
    ]);

    expect([...assembledOriginal]).toEqual([...original]);
    expect([...assembledDenoised]).toEqual([...denoised]);
    await storage.removeStaged(common.id, common.startedAt, common.mimeType, 'analysis');
    expect([...await storage.assemble({ ...common, expectedByteLength: original.length })]).toEqual([...original]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
