import { MAX_TRANSCRIBABLE_RECORDING_SECONDS } from '@itc/domain';

export const SAMPLE_RATE = 16_000;
export const BYTES_PER_MS = SAMPLE_RATE * 2 / 1000;
export const MAX_RECORDING_MS = MAX_TRANSCRIBABLE_RECORDING_SECONDS * 1000;
const MAX_CLIP_MS = 30_000;
const MERGE_GAP_MS = 250;
export const MIN_TRANSCRIBABLE_CLIP_MS = 100;

interface Interval {
  startMs: number;
  endMs: number;
}

interface SpeakerInterval extends Interval {
  speaker: string;
}

function validInterval(value: unknown, durationMs: number): value is Interval {
  if (!value || typeof value !== 'object' || !('startMs' in value) || !('endMs' in value)) return false;
  const { startMs, endMs } = value;
  return typeof startMs === 'number' && Number.isInteger(startMs) && startMs >= 0
    && typeof endMs === 'number' && Number.isInteger(endMs) && endMs > startMs && endMs <= durationMs;
}

export function readTimeline(value: unknown, durationMs: number) {
  if (!value || typeof value !== 'object' || !('source' in value) || typeof value.source !== 'string'
    || !('turns' in value) || !Array.isArray(value.turns)
    || !('overlaps' in value) || !Array.isArray(value.overlaps)) {
    throw new Error('Invalid diarization result.');
  }
  const turns: SpeakerInterval[] = [];
  for (const turn of value.turns) {
    if (!validInterval(turn, durationMs) || !('speaker' in turn) || typeof turn.speaker !== 'string' || !turn.speaker.trim()) {
      throw new Error('Invalid speaker interval in diarization result.');
    }
    turns.push({ startMs: turn.startMs, endMs: turn.endMs, speaker: turn.speaker });
  }
  const overlaps: Interval[] = value.overlaps;
  if (overlaps.some((interval) => !validInterval(interval, durationMs))) {
    throw new Error('Invalid overlap interval in diarization result.');
  }
  turns.sort((a, b) => a.startMs - b.startMs);
  if (turns.some((turn, index) => index > 0 && turn.startMs < turns[index - 1]!.endMs)) {
    throw new Error('The exclusive speaker timeline contains overlapping turns.');
  }
  return { source: value.source, turns, overlaps };
}

export function makeClips(turns: SpeakerInterval[], overlaps: Interval[]) {
  const grouped: SpeakerInterval[] = [];
  for (const turn of turns) {
    const last = grouped.at(-1);
    if (last?.speaker === turn.speaker && turn.startMs - last.endMs <= MERGE_GAP_MS
      && turn.endMs - last.startMs <= MAX_CLIP_MS) {
      last.endMs = turn.endMs;
    } else {
      grouped.push({ ...turn });
    }
  }

  const labels = new Map<string, number>();
  return grouped.flatMap((turn) => {
    if (!labels.has(turn.speaker)) labels.set(turn.speaker, labels.size + 1);
    const count = Math.ceil((turn.endMs - turn.startMs) / MAX_CLIP_MS);
    return Array.from({ length: count }, (_, index) => {
      const startMs = turn.startMs + Math.floor((turn.endMs - turn.startMs) * index / count);
      const endMs = turn.startMs + Math.floor((turn.endMs - turn.startMs) * (index + 1) / count);
      return {
        startMs,
        endMs,
        speaker: `Speaker ${labels.get(turn.speaker)}`,
        overlapsSpeech: overlaps.some((overlap) => startMs < overlap.endMs && overlap.startMs < endMs)
      };
    });
  }).filter((clip) => clip.endMs - clip.startMs >= MIN_TRANSCRIBABLE_CLIP_MS);
}

export function wavFromPcm(pcm: Uint8Array) {
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // Mono
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40);
  wav.set(pcm, 44);
  return wav;
}

