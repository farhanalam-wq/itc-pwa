# OpenAI recording transcription

The API transcribes a recording only after the PWA has finished syncing its merged conversation audio and the configured storage adapter confirms the final object is durable. Transport chunks are assembled into one final audio file; MongoDB stores job state and transcript text, never audio bytes.

## API configuration

Add these values to the ignored `apps/api/.env` file on the API machine:

```dotenv
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DATABASE=itc_field_source
STORAGE_DRIVER=local
LOCAL_RECORDING_DIR=./var/recordings
OPENAI_API_KEY=your-server-side-openai-api-key
```

For S3, set `STORAGE_DRIVER=s3`, `AWS_REGION`, `S3_BUCKET_NAME`, and provide AWS credentials to the API runtime through its role/profile/credential chain. Keep `OPENAI_API_KEY` and AWS credentials out of the manager and field PWA environment files. Do not commit `.env` files.

Restart the API after changing the key. The API health response reports transcription configuration as `runtime.analysis`; it never returns the key. `OPENAI_API_KEY` is not required for local recording storage, so the audio can still sync if transcription is temporarily unconfigured.

## Processing behavior

- Finalized audio is queued in MongoDB and processed by the API worker using OpenAI's `gpt-transcribe` model. The request lists English, Hindi, and Bangla as possible languages. The prompt asks the model to preserve switches within a sentence and use Latin, Devanagari, and Bengali script respectively. The result still depends on the model's recognition.
- The transcript job state is `queued`, `processing`, `completed`, or `failed`. Stale processing leases are reclaimed after ten minutes; the API checks the durable queue on startup and every minute.
- Temporary provider/network failures are retryable. The manager can request a retry through the authenticated recording transcript endpoint after a later UI phase exposes that action.
- The provider returns plain transcript text and detected language codes when present. This model path does not supply speaker turns, word/segment timestamps, or confidence, so the API does not invent them.
- New recordings over 25 MB stay on the device and cannot be synced by this flow. Older uploaded recordings over the limit stay available for playback and receive an `audio_too_large` transcription status.
- Transcript text and language metadata are stored in the MongoDB `transcription_jobs` collection. Audio remains in the selected local/S3 object store.

OpenAI file transcription guide: <https://developers.openai.com/api/docs/guides/speech-to-text>

## Speaker diarization prototype

This command runs outside the upload and manager flow. It decodes one local recording to 16 kHz mono PCM with FFmpeg, gives pyannote Community-1 the full waveform, and cuts clips from the same PCM using the exclusive speaker timeline. Short gaps between consecutive turns from the same speaker can be merged. Clips are capped at 30 seconds, speaker labels are local to one recording, and overlapped speech is flagged.

Use a compatible Python environment (Python 3.12 is a starting point) with the dependencies in `apps/api/pyannote/requirements.txt` and FFmpeg on your PATH. Accept the [Community-1 access conditions](https://huggingface.co/pyannote/speaker-diarization-community-1) and configure `HF_TOKEN` in your shell or the ignored `apps/api/.env`. Alternatively, point `PYANNOTE_MODEL_DIR` to a local copy of the model. Set `PYANNOTE_PYTHON` to the interpreter in your Python environment if it differs from `python3`.

From the repository root, use an absolute path to an audio sample up to 10 minutes long:

```bash
bun run --cwd apps/api prototype:diarize /path/to/consented-sample.webm
bun run --cwd apps/api prototype:diarize /path/to/consented-sample.webm --transcribe
```

The first command runs diarization and prints the clip plan as JSON. The second uses the server's `OPENAI_API_KEY` to request a whole-file baseline and one GPT transcript per clip, then reports timings and request counts. The report may contain conversation text. Keep samples and reports outside Git.

For a local check without pyannote or OpenAI, pass `--synthetic-timeline /path/to/fixture.json` instead of `--transcribe`. Fixture format:

```json
{
  "source": "synthetic",
  "turns": [
    { "startMs": 0, "endMs": 1200, "speaker": "A" },
    { "startMs": 1300, "endMs": 2500, "speaker": "B" }
  ],
  "overlaps": []
}
```

Before wiring Modal or MongoDB, compare the outputs on consented samples with English, Hindi and Bangla in different orders. Check speaker changes, short replies, word clipping at clip boundaries and script switches within a turn. The prototype marks overlapping speech but does not separate it into individual voice tracks. Confirm the quality and cost of the clip approach before adding background retries and the admin view.
