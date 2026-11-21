import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BYTES_PER_MS, MAX_RECORDING_MS, SAMPLE_RATE, makeClips, readTimeline, wavFromPcm } from '../services/diarization-audio';
import { ModalDiarizationClient, readModalDiarizationConfig } from './modal-diarization';
import { OpenAIAudioTranscriptionProvider, readOpenAITranscriptionConfig } from '../services/openai-transcription';

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
