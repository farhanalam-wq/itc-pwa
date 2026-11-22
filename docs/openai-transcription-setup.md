# OpenAI recording transcription

The API transcribes a recording only after the PWA has finished syncing its merged conversation audio and the configured storage adapter confirms the final object is durable. Transport chunks are assembled into one final audio file; MongoDB stores job state and transcript text, never audio bytes.

## API configuration

Add these values to the ignored `apps/api/.env` file on the API machine. The API requires OpenAI, Modal, and FFmpeg configuration before it starts its audio pipeline:

```dotenv
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DATABASE=itc_field_source
STORAGE_DRIVER=local
LOCAL_RECORDING_DIR=./var/recordings
OPENAI_API_KEY=your-server-side-openai-api-key
MODAL_DIARIZATION_URL=https://your-workspace--your-app.modal.run
MODAL_DIARIZATION_KEY=your-modal-proxy-key
MODAL_DIARIZATION_SECRET=your-modal-proxy-secret
```

Install FFmpeg on the API host. For S3, set `STORAGE_DRIVER=s3`, `AWS_REGION`, `S3_BUCKET_NAME`, and provide AWS credentials to the API runtime through its role/profile/credential chain. Keep OpenAI, Modal, and AWS credentials out of the manager and field PWA environment files. Do not commit `.env` files.

Restart the API after changing configuration. The API health response reports whether the complete transcription pipeline is configured as `runtime.analysis`; it never returns credentials. Audio uploads are confirmed independently of transcription, but the API will not start until the pipeline configuration is present.

## Processing behavior

- Finalized audio is queued in MongoDB and processed through pyannote Community-1 on Modal for speaker turns, then OpenAI's `gpt-transcribe` model transcribes each speaker clip. OpenAI receives no diarization request. Its clip requests list English, Hindi, and Bangla as possible languages and ask the model to preserve switches within a sentence using Latin, Devanagari, and Bengali script respectively. Recognition still depends on the model.
- The transcript job state is `queued`, `processing`, `completed`, or `failed`. Stale processing leases are reclaimed after ten minutes; the API checks the durable queue on startup and every minute.
- Temporary provider/network failures are retryable. The manager can request a retry through the authenticated recording transcript endpoint after a later UI phase exposes that action.
- OpenAI returns clip transcript text and detected language codes when present. Pyannote supplies speaker intervals and overlap markers. The API does not invent word-level timings or confidence.
- Recordings can sync regardless of file size. The current diarization pipeline supports recordings up to 10 minutes; longer audio remains stored but receives an `audio_too_large` transcription status.
- Transcript text and language metadata are stored in the MongoDB `transcription_jobs` collection. Audio remains in the selected local/S3 object store.

OpenAI file transcription guide: <https://developers.openai.com/api/docs/guides/speech-to-text>

## Speaker diarization prototype

This command runs outside the upload and manager flow. Live diarization in both the API and prototype uses pyannote Community-1 on Modal. It decodes audio to 16 kHz mono PCM and cuts clips from the same PCM using the exclusive speaker timeline. Short gaps between consecutive turns from the same speaker can be merged. Clips are capped at 30 seconds, speaker labels are local to one recording, and overlapped speech is flagged.

Configure the Modal app and its Hugging Face model secret as described below. The API host needs FFmpeg; model weights run in the Modal GPU worker.

From the repository root, use an absolute path to an audio sample up to 10 minutes long:

```bash
bun run --cwd apps/api prototype:diarize /path/to/consented-sample.webm --modal
bun run --cwd apps/api prototype:diarize /path/to/consented-sample.webm --modal --transcribe
```

The first command runs Modal diarization and prints the clip plan as JSON. The second uses the server's `OPENAI_API_KEY` to transcribe the resulting clips and report timings and request counts. The report may contain conversation text. Keep samples and reports outside Git.

For a local clip-planning check without live pyannote or OpenAI calls, pass `--synthetic-timeline /path/to/fixture.json`. Fixture format:

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

Compare the outputs on synthetic or approved samples with English, Hindi and Bangla in different orders. Check speaker changes, short replies, word clipping at clip boundaries and script switches within a turn. The prototype marks overlapping speech but does not separate it into individual voice tracks.

### Modal staging

The Modal app runs pyannote Community-1 on a GPU. The API or Bun prototype decodes audio to 16 kHz mono PCM, sends it to Modal, and uses the same PCM for GPT clips. The Modal app returns speaker and overlap intervals and the hash of the submitted PCM. MongoDB, audio storage, clip transcription, and the manager stay on the existing API.

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

For staging acceptance, verify the endpoint rejects unauthenticated requests, compare returned intervals with synthetic reference intervals, and measure first and subsequent requests separately. Use Modal invocation telemetry for actual GPU cost. The prototype reports both elapsed time including polling and inference time from the worker.

Use synthetic audio in staging. Modal stores asynchronous function payloads in the United States. Confirm audio residency and retention requirements before using this transport for field recordings. See [Modal data residency](https://modal.com/docs/guide/data-residency).

### Staging verification, 21 November 2026

The deployed endpoint rejected an unauthenticated request with HTTP 401. With proxy credentials, it returned nine intervals for the 22.7-second, two-voice synthetic recording. The returned intervals matched the local Community-1 run exactly on this recording. A new CLI process retrieved the same completed result by job ID without resubmitting audio.

The initial request took about 270 seconds including queueing and startup, with 1.64 seconds reported by the worker for inference. Subsequent submissions returned in 5–7 seconds including polling, with about 0.37 seconds of inference. Resuming the completed job took under a second. These are individual observations, not a latency guarantee or a measurement of billed cost.

The [synthetic stress evaluation](../apps/api/evaluation/README.md) found both speakers in the expected order with noise and overlap. GPT still made some script and wording errors when languages switched inside an uninterrupted phrase. Review those quality limits and Modal audio residency before production use.

## Required speaker diarization in the API

Every new API transcription uses pyannote Community-1 on Modal for speaker turns, followed by GPT transcription of the clips. Install FFmpeg on the API host and configure the Modal URL and proxy credentials. The API fails to start if Modal, FFmpeg, or the OpenAI transcription key is missing.

Diarized jobs send decoded audio to Modal once and store the job ID in MongoDB. The API resumes from the saved ID after a restart when Modal still has the result. It stores each completed GPT clip so a retry can skip clips already saved. Previously queued whole-file jobs are also processed through the diarized pipeline. Completed legacy transcripts remain unchanged until reprocessed.

The manager displays elapsed timestamps, anonymous speaker labels, and flags for overlapping speech. Select a timestamp to play from that point in the stored recording. Legacy completed transcripts without a pyannote result offer an **Add speaker turns** action, which reprocesses the stored recording through the required pipeline. There is no bulk backfill.

Start with synthetic or approved pilot audio. Confirm residency and retention requirements before processing real field audio. The synthetic noise/overlap evaluation still found script mistakes when languages changed within a phrase. Treat the text as a model result and use the source audio to verify it.

### Pipeline verification

On 21 November 2026, a completed synthetic recording was reprocessed through the authenticated API against an isolated MongoDB and the live Modal and GPT services. The API returned nine turns for two voices, with model provenance, and rejected a concurrent reprocess request. A separate restart check confirmed that a reclaimed job kept its Modal ID and completed clip and that the old attempt could not write. The manager was checked in Chromium with a synthetic transcript for keyboard focus, timestamp seeking, overlap labeling, and reprocess feedback.
