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

### Modal staging

The staging app runs pyannote Community-1 on a GPU. The Bun prototype decodes the audio locally, sends the resulting 16 kHz mono PCM to Modal, and uses that same PCM for the GPT clips. The Modal app returns speaker and overlap intervals and the hash of the submitted PCM. MongoDB, audio storage, GPT transcription, and the manager stay on the existing API.

1. Install the Modal CLI using the version in `apps/api/pyannote/requirements-modal.txt` and authenticate it in the intended Modal workspace. Set `MODAL_ENVIRONMENT` if that workspace uses a dedicated staging environment.
2. In that environment, create the Modal Secret `itc-pyannote-huggingface` with the `HF_TOKEN` entry only. The model download needs this token. The running GPU worker loads the pinned weights from a Volume.
3. From the repository root, download the weights and deploy:

   ```bash
   modal run apps/api/pyannote/modal_app.py::download_model
   modal deploy apps/api/pyannote/modal_app.py
   ```

4. Create a Modal proxy token for the endpoint and configure the following in the ignored `apps/api/.env`. Use the HTTPS origin shown by deployment. The proxy token is separate from the Modal CLI credentials.

   ```dotenv
   MODAL_DIARIZATION_URL=https://your-workspace--your-app.modal.run
   MODAL_DIARIZATION_KEY=wk_your_proxy_key
   MODAL_DIARIZATION_SECRET=ws_your_proxy_secret
   ```

5. Submit a synthetic recording for the staging comparison:

   ```bash
   bun run --cwd apps/api prototype:diarize /path/to/synthetic-sample.wav --modal --transcribe
   ```

   Omit `--transcribe` to check only the Modal timeline. The prototype prints the Modal job ID to stderr before polling. To pick up the same job in a new process, rerun the command with `--resume-job <id>` and the same input file. The client validates the audio hash before using the timeline. If submit times out before returning an ID, the client reports the error instead of automatically starting a second job.

For staging acceptance, verify the endpoint rejects unauthenticated requests, compare returned intervals with the local run on the same PCM, and measure first and subsequent requests separately. Use Modal invocation telemetry for actual GPU cost. The prototype reports both elapsed time including polling and inference time from the worker.

Use synthetic audio in staging. Modal stores asynchronous function payloads in the United States. Confirm audio residency and retention requirements before using this transport for field recordings. See [Modal data residency](https://modal.com/docs/guide/data-residency).

### Staging verification, 21 November 2026

The deployed endpoint rejected an unauthenticated request with HTTP 401. With proxy credentials, it returned nine intervals for the 22.7-second, two-voice synthetic recording. The returned intervals matched the local Community-1 run exactly on this recording. A new CLI process retrieved the same completed result by job ID without resubmitting audio.

The initial request took about 270 seconds including queueing and startup, with 1.64 seconds reported by the worker for inference. Subsequent submissions returned in 5–7 seconds including polling, with about 0.37 seconds of inference. Resuming the completed job took under a second. These are individual observations, not a latency guarantee or a measurement of billed cost.

The [synthetic stress evaluation](../apps/api/evaluation/README.md) found both speakers in the expected order with noise and overlap. GPT still made some script and wording errors when languages switched inside an uninterrupted phrase. Keep this path in staging until those quality limits and Modal audio residency have been reviewed.
