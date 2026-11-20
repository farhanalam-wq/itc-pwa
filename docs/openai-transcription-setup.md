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

- Finalized audio is queued in MongoDB and processed by the API worker using OpenAI's `gpt-transcribe` model.
- The transcript job state is `queued`, `processing`, `completed`, or `failed`. Stale processing leases are reclaimed after ten minutes; the API checks the durable queue on startup and every minute.
- Temporary provider/network failures are retryable. The manager can request a retry through the authenticated recording transcript endpoint after a later UI phase exposes that action.
- The provider returns plain transcript text and detected language codes when present. This model path does not supply speaker turns, word/segment timestamps, or confidence, so the API does not invent them.
- New recordings over 25 MB stay on the device and cannot be synced by this flow. Older uploaded recordings over the limit stay available for playback and receive an `audio_too_large` transcription status.
- Transcript text and language metadata are stored in the MongoDB `transcription_jobs` collection. Audio remains in the selected local/S3 object store.

OpenAI file transcription guide: <https://developers.openai.com/api/docs/guides/speech-to-text>
