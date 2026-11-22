import { expect, test } from 'bun:test';
import { makeClips, MIN_TRANSCRIBABLE_CLIP_MS } from './diarization-audio';

test('drops sub-100 ms speaker fragments before creating transcription clips', () => {
  const clips = makeClips([
    { speaker: 'A', startMs: 0, endMs: 400 },
    { speaker: 'B', startMs: 401, endMs: 418 },
    { speaker: 'A', startMs: 420, endMs: 900 },
    { speaker: 'B', startMs: 950, endMs: 1050 }
  ], []);

  expect(clips).toEqual([
    { startMs: 0, endMs: 400, speaker: 'Speaker 1', overlapsSpeech: false },
    { startMs: 420, endMs: 900, speaker: 'Speaker 1', overlapsSpeech: false },
    { startMs: 950, endMs: 1050, speaker: 'Speaker 2', overlapsSpeech: false }
  ]);
  expect(clips.every((clip) => clip.endMs - clip.startMs >= MIN_TRANSCRIBABLE_CLIP_MS)).toBe(true);
});
