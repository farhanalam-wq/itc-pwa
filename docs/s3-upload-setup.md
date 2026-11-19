# Recording storage and S3 setup

The field PWA saves one merged conversation audio file in OPFS. When connectivity returns, it registers visit/recording metadata and sends bounded transport chunks to the API. The API validates and assembles those chunks, writes one final audio object to the selected storage adapter, and persists its reference/checksum in MongoDB. Transport chunks are temporary staging data; they do not become separate S3 objects.

```text
PWA recording -> OPFS queue -> API chunk staging -> one final local/S3 audio object
                                                    -> MongoDB recording metadata
                                                    -> OpenAI transcription job
```

## Configure the API

Copy `apps/api/.env.example` to the ignored `apps/api/.env`. Choose exactly one storage mode.

### Local VM storage

```dotenv
STORAGE_DRIVER=local
LOCAL_RECORDING_DIR=./var/recordings
LOCAL_UPLOAD_STAGING_DIR=./var/upload-staging
```

The API writes the finalized audio below `LOCAL_RECORDING_DIR`, partitioned by UTC date and recording ID. Mount this directory to persistent VM storage in deployments. `./var/upload-staging` holds temporary chunk transport data and can be cleaned after successful finalization.

### S3 storage

```dotenv
STORAGE_DRIVER=s3
AWS_REGION=ap-south-1
S3_BUCKET_NAME=vyom-backend-demo
S3_RECORDING_PREFIX=field-source/recordings
```

The API writes the one merged recording as:

```text
field-source/recordings/YYYY/MM/DD/{recording-id}.webm
```

S3 prefixes act as folders; no empty folder objects need to be created. Keep the bucket private and Block Public Access enabled. Supply credentials to the API through its AWS SDK role/profile/credential chain. Do not put AWS keys in either frontend.

The API role needs `s3:PutObject` and `s3:GetObject` for:

```text
arn:aws:s3:::vyom-backend-demo/field-source/recordings/*
```

The field browser uploads to the API, not directly to S3, so this audio flow does not require bucket CORS. The manager gets short-lived playback URLs from the API for S3 recordings. MongoDB stores the storage driver, object key and checksum, not audio bytes or an expiring URL.

## MongoDB and OpenAI

The API requires `MONGODB_URI` and `MONGODB_DATABASE` for administrator, visit/recording, and transcription-job metadata. To transcribe stored audio, set the server-only `OPENAI_API_KEY` as described in [OpenAI transcription setup](openai-transcription-setup.md). Do not add secrets to `VITE_` variables or commit `.env` files.

## Start the apps

From the repository root, after starting MongoDB and configuring `apps/api/.env`:

```bash
bun run dev:api
bun run dev:field
bun run dev:manager
```

The API runs on port 3004, the field PWA on 5173, and the manager on 5180. The Vite apps proxy `/api` to the API. `bun run dev` starts all workspace apps through Turborepo.

Create the first administrator using the one-time setup token and steps in [admin account setup](admin-account-setup.md). After account creation, remove `ADMIN_SETUP_TOKEN` from the API environment and restart it.

## What to verify

1. With the field PWA online, create a consented visit, record and stop. Confirm one recording appears in history.
2. Turn connectivity off before syncing. Confirm the merged audio stays queued in OPFS and survives a page reload.
3. Reconnect. Confirm chunk progress finishes, API storage confirms the single final object, and the PWA marks it uploaded only after API confirmation.
4. In the manager, sign in and open **Transcript status** on the real capture. Confirm it advances through queue/transcription to the returned plain text, or shows a clear retryable/permanent error.
5. For S3 mode, verify the final key exists under the configured prefix and MongoDB contains the same object key/checksum. For local mode, verify one file exists under the persistent local root.

The current workspace has not been exercised against live AWS, MongoDB, or OpenAI credentials. Use the preceding checks in the configured deployment before the demo; code-level in-process workflow checks are documented in `docs/implementation-plan.md`.
