import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RecordingTranscriptTurn } from '@itc/domain';
import type { TranscriptionJob } from '../repositories/mongo-transcription-repository';
import { BYTES_PER_MS, MAX_RECORDING_MS, MIN_TRANSCRIBABLE_CLIP_MS, SAMPLE_RATE, makeClips, readTimeline, wavFromPcm } from './diarization-audio';
import { ModalDiarizationClient, ModalJobFailedError } from './modal-diarization';
import { AudioTranscriptionError, OPENAI_TRANSCRIPTION_MODEL, type AudioTranscriptionProvider } from './openai-transcription';

type Diarization = NonNullable<TranscriptionJob['diarization']>;
type Checkpoint = (stage: 'diarizing' | 'transcribing', value: Diarization) => Promise<void>;
const MAX_CLIPS = 500;

const demuxers: Record<string, string> = {
  'audio/webm': 'matroska',
  'video/webm': 'matroska',
  'audio/mp4': 'mov',
  'video/mp4': 'mov',
  'audio/x-m4a': 'mov',
  'audio/m4a': 'mov',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp3': 'mp3',
  'audio/mpeg': 'mp3',
  'audio/mpga': 'mp3',
  'audio/flac': 'flac'
};

async function decodeRecording(bytes: Uint8Array, mimeType: string, signal: AbortSignal) {
  const demuxer = demuxers[mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? ''];
  if (!demuxer) {
    throw new AudioTranscriptionError('unsupported_audio_format', 'This format is not supported by speaker diarization.');
  }
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), 'itc-diarization-worker-'));
  try {
    const path = join(directory, 'input');
    const pcmPath = join(directory, 'decoded.pcm');
    await Bun.write(path, bytes);
    const ffmpeg = Bun.which('ffmpeg');
    if (!ffmpeg) {
      throw new AudioTranscriptionError('provider_not_configured', 'FFmpeg is required for speaker diarization.', true);
    }
    const decode = Bun.spawn([
      ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-protocol_whitelist', 'file', '-f', demuxer, '-i', path,
      '-map', '0:a:0', '-t', String(MAX_RECORDING_MS / 1000 + 1),
      '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', pcmPath
    ], { stdout: 'ignore', stderr: 'ignore', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
    const code = await decode.exited;
    signal.throwIfAborted();
    if (code !== 0) {
      throw new AudioTranscriptionError('unsupported_audio_format', 'The voice recording could not be decoded for diarization.');
    }
    const pcm = await Bun.file(pcmPath).bytes();
    if (pcm.length > MAX_RECORDING_MS * BYTES_PER_MS) {
      throw new AudioTranscriptionError('audio_too_large', 'Speaker diarization currently supports recordings up to 10 minutes.');
    }
    if (pcm.length < BYTES_PER_MS) {
      throw new AudioTranscriptionError('empty_audio', 'The decoded recording contains no usable audio.');
    }
    return pcm;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export class DiarizedTranscriptionPipeline {
  constructor(private readonly modal: Pick<ModalDiarizationClient, 'run'>) {}

  async transcribe(input: {
    job: TranscriptionJob;
    bytes: Uint8Array;
    mimeType: string;
    expectedDurationSeconds?: number;
    provider: AudioTranscriptionProvider;
    checkpoint: Checkpoint;
    signal: AbortSignal;
  }) {
    const { job, bytes, mimeType, provider, checkpoint, signal } = input;
    const pcm = await decodeRecording(bytes, mimeType, signal);
    if (input.expectedDurationSeconds !== undefined) {
      const decodedDurationSeconds = pcm.length / (SAMPLE_RATE * 2);
      const toleranceSeconds = Math.max(2, Math.min(5, input.expectedDurationSeconds * 0.05));
      if (Math.abs(decodedDurationSeconds - input.expectedDurationSeconds) > toleranceSeconds) {
        throw new AudioTranscriptionError('denoised_audio_duration_mismatch', 'The denoised analysis audio duration did not match its registered metadata.');
      }
    }
    const audioSha256 = createHash('sha256').update(pcm).digest('hex');
    let progress = job.diarization ?? { audioSha256 };
    if (progress.audioSha256 && progress.audioSha256 !== audioSha256) {
      throw new AudioTranscriptionError('transcription_failed', 'Decoded audio differs from the original transcription attempt.');
    }
    let clips = progress.clips;
    let diarizer = progress.diarizer;
    if (!clips) {
      await checkpoint('diarizing', progress);
      let response: Awaited<ReturnType<ModalDiarizationClient['run']>>;
      try {
        response = await this.modal.run(pcm, {
          signal,
          resumeJobId: progress.modalJobId,
          onJobId: async (modalJobId) => {
            progress = { ...progress, audioSha256, modalJobId };
            await checkpoint('diarizing', progress);
          }
        });
      } catch (error) {
        if (error instanceof ModalJobFailedError) {
          // On explicit retry a terminal remote job needs a replacement. Network and
          // client-side polling timeouts retain the remote ID for resumption.
          await checkpoint('diarizing', { audioSha256 });
        }
        signal.throwIfAborted();
        throw new AudioTranscriptionError('provider_unavailable', 'Speaker diarization did not complete. Retry to continue.', true);
      }
      const timeline = readTimeline(response.timeline, Math.round(pcm.length / BYTES_PER_MS));
      clips = makeClips(timeline.turns, timeline.overlaps).map((clip, index) => ({ id: `turn-${index + 1}`, ...clip }));
      diarizer = { model: timeline.source, revision: response.modelRevision };
    }

    // Modal can emit tiny speaker fragments at turn boundaries. Keep these out
    // of provider requests because sub-100 ms WAV clips are routinely rejected,
    // and apply the same rule when resuming a job with saved diarization data.
    clips = clips.filter((clip) => clip.endMs - clip.startMs >= MIN_TRANSCRIBABLE_CLIP_MS);
    if (clips.length > MAX_CLIPS) {
      throw new AudioTranscriptionError('transcription_failed', 'The diarizer returned too many speech clips.');
    }
    progress = { ...progress, audioSha256, ...(diarizer ? { diarizer } : {}), clips };
    await checkpoint('transcribing', progress);

    for (const clip of clips) {
      if (clip.text !== undefined) continue;
      // Fence each network side effect and each result write against a retry or deletion.
      await checkpoint('transcribing', progress);
      signal.throwIfAborted();
      const audio = pcm.subarray(clip.startMs * BYTES_PER_MS, clip.endMs * BYTES_PER_MS);
      const result = await provider.transcribe({
        recordingId: `${job.recordingId}-${clip.id}`,
        mimeType: 'audio/wav',
        bytes: wavFromPcm(audio),
        signal
      });
      clip.text = result.text;
      clip.languageCodes = result.languageCodes;
      await checkpoint('transcribing', progress);
    }

    const turns: RecordingTranscriptTurn[] = clips.map(({ languageCodes: _languageCodes, text, ...clip }) => ({
      ...clip, text: text ?? ''
    })).filter((clip) => clip.text.trim());
    return {
      turns,
      diarizer: progress.diarizer,
      text: turns.map(({ speaker, text }) => `${speaker}: ${text}`).join('\n'),
      languageCodes: [...new Set(clips.flatMap((clip) => clip.languageCodes ?? []))],
      model: OPENAI_TRANSCRIPTION_MODEL
    };
  }
}
