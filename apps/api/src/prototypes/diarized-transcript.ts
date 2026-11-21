import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ModalDiarizationClient, readModalDiarizationConfig } from './modal-diarization';
import { OpenAIAudioTranscriptionProvider, readOpenAITranscriptionConfig } from '../services/openai-transcription';

const SAMPLE_RATE = 16_000;
const BYTES_PER_MS = SAMPLE_RATE * 2 / 1000;
const MAX_RECORDING_MS = 600_000;
const MAX_CLIP_MS = 30_000;
const MERGE_GAP_MS = 250;

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

function readTimeline(value: unknown, durationMs: number) {
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

function makeClips(turns: SpeakerInterval[], overlaps: Interval[]) {
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
  });
}

function wavFromPcm(pcm: Uint8Array) {
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

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      transcribe: { type: 'boolean' },
      modal: { type: 'boolean' },
      'resume-job': { type: 'string' },
      'synthetic-timeline': { type: 'string' },
      help: { type: 'boolean' }
    }
  });
  if (values.help) {
    console.log('Usage: bun run prototype:diarize <audio> [--modal [--resume-job <id>]] [--transcribe | --synthetic-timeline <json>]');
    return;
  }
  const [input] = positionals;
  if (!input || positionals.length !== 1) throw new Error('Pass one recording. Use --help for usage.');
  if ((values.transcribe || values.modal) && values['synthetic-timeline']) {
    throw new Error('Synthetic timelines support local clip planning only.');
  }
  if (values['resume-job'] && !values.modal) throw new Error('--resume-job requires --modal.');
  const modalClient = values.modal ? new ModalDiarizationClient(readModalDiarizationConfig()) : undefined;
  if (values.transcribe && !readOpenAITranscriptionConfig().configured) {
    throw new Error('Set OPENAI_API_KEY to enable transcription.');
  }
  const audioPath = resolve(input);
  if (!await Bun.file(audioPath).exists()) throw new Error('Recording file not found.');

  const dir = await mkdtemp(join(tmpdir(), 'itc-diarization-'));
  try {
    const pcmPath = join(dir, 'recording.pcm');
    const decode = Bun.spawn([
      'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', audioPath,
      '-map', '0:a:0', '-t', String(MAX_RECORDING_MS / 1000 + 1),
      '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', pcmPath
    ], { stdout: 'ignore', stderr: 'inherit' });
    if (await decode.exited !== 0) throw new Error('FFmpeg could not decode the recording.');

    const pcm = await Bun.file(pcmPath).bytes();
    const durationMs = Math.round(pcm.length / BYTES_PER_MS);
    if (!durationMs || durationMs > MAX_RECORDING_MS) throw new Error('Use a recording between 1 ms and 10 minutes for this prototype.');

    const syntheticPath = values['synthetic-timeline'];
    let rawTimeline: unknown;
    let modalJobId: string | undefined;
    let modalModelRevision: string | undefined;
    let modalInferenceMs: number | undefined;
    let modalGpu: string | undefined;
    const diarizationStart = performance.now();
    if (syntheticPath) {
      rawTimeline = await Bun.file(syntheticPath).json();
    } else if (modalClient) {
      const result = await modalClient.run(pcm, {
        resumeJobId: values['resume-job'],
        onJobId: (id) => console.error(`Modal job: ${id}. To resume after interruption, rerun with --modal --resume-job ${id}.`)
      });
      modalJobId = result.jobId;
      modalModelRevision = result.modelRevision;
      modalInferenceMs = result.inferenceMs;
      modalGpu = result.gpu;
      rawTimeline = result.timeline;
    } else {
      const python = Bun.env.PYANNOTE_PYTHON || 'python3';
      const script = fileURLToPath(new URL('../../pyannote/diarize.py', import.meta.url));
      const diarize = Bun.spawn([python, script, pcmPath], { stdout: 'pipe', stderr: 'inherit' });
      const [output, code] = await Promise.all([new Response(diarize.stdout).text(), diarize.exited]);
      if (code !== 0) throw new Error('pyannote failed. Check the Python environment and model access.');
      rawTimeline = JSON.parse(output);
    }

    const timeline = readTimeline(rawTimeline, durationMs);
    const clips = makeClips(timeline.turns, timeline.overlaps).map((clip) => {
      const audio = pcm.subarray(clip.startMs * BYTES_PER_MS, clip.endMs * BYTES_PER_MS);
      return { ...clip, audio };
    });
    const report = {
      source: syntheticPath ? 'synthetic-timeline' : timeline.source,
      durationMs,
      ...(modalJobId ? { modalJobId } : {}),
      ...(modalModelRevision ? { modalModelRevision } : {}),
      ...(modalInferenceMs !== undefined ? { modalInferenceMs } : {}),
      ...(modalGpu ? { modalGpu } : {}),
      ...(!syntheticPath ? { diarizationElapsedMs: Math.round(performance.now() - diarizationStart) } : {}),
      speakerIntervals: timeline.turns,
      overlapIntervals: timeline.overlaps
    };
    if (!values.transcribe) {
      console.log(JSON.stringify({
        ...report,
        clips: clips.map(({ audio, ...clip }) => ({ ...clip, sampleCount: audio.length / 2 }))
      }, null, 2));
      return;
    }

    const provider = new OpenAIAudioTranscriptionProvider();
    const baselineStart = performance.now();
    const baseline = await provider.transcribe({
      recordingId: 'prototype-whole', mimeType: 'audio/wav', bytes: wavFromPcm(pcm)
    });
    const baselineElapsedMs = Math.round(performance.now() - baselineStart);
    const clipTranscriptionStart = performance.now();
    const turns = [];
    for (const [index, { audio, ...clip }] of clips.entries()) {
      const transcript = await provider.transcribe({
        recordingId: `prototype-turn-${index + 1}`, mimeType: 'audio/wav', bytes: wavFromPcm(audio)
      });
      turns.push({ ...clip, ...transcript });
    }
    console.log(JSON.stringify({
      ...report,
      baseline,
      baselineElapsedMs,
      clipTranscriptionElapsedMs: Math.round(performance.now() - clipTranscriptionStart),
      clipRequests: clips.length,
      turns
    }, null, 2));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Prototype failed.');
  process.exitCode = 1;
});
