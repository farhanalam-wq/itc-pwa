# S3 recording upload setup

The field PWA keeps each recording in OPFS first. After the device is online and the visit metadata is registered, the API issues a short-lived presigned S3 `PUT` URL. The PWA uploads the audio bytes directly to the bucket, then asks the API to verify the object size. AWS credentials stay in the API environment and are never shipped to the browser.

## API environment

Copy `apps/api/.env.example` to `apps/api/.env` and set:

| Variable | Required | Purpose |
| --- | --- | --- |
| `AWS_REGION` | Yes | Region containing the bucket. |
| `S3_BUCKET_NAME` | Yes | Private bucket name. The supplied demo bucket is `vyom-backend-demo`. `S3_BUCKET` remains a fallback alias for older setups. |
| `S3_RECORDING_PREFIX` | No | Audio object root; defaults to `field-source/recordings`. |
| `S3_TRANSCRIPT_PREFIX` | No | Manually ingested transcript root; defaults to `field-source/transcripts`. |
| `S3_PRESIGNED_URL_TTL_SECONDS` | No | Upload and playback URL lifetime; defaults to 900 seconds and is limited to 60–3600 seconds. |
| `AWS_PROFILE` | Local dev | Optional shared AWS CLI profile. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | Optional | AWS SDK credential-chain inputs. Prefer a local profile or an IAM role over long-lived keys. |

Use the same region as the bucket. The AWS SDK uses its default credential provider chain, so deployment should use a scoped IAM role. The API reports uploads as configured when a region and bucket are present; an actual upload still requires valid credentials and permissions.

The API role needs `s3:PutObject` on both object roots and `s3:GetObject` on recordings for playback and upload verification:

```text
arn:aws:s3:::vyom-backend-demo/field-source/recordings/*
arn:aws:s3:::vyom-backend-demo/field-source/transcripts/*
```

Grant `s3:GetObject` to the recordings path only. Transcript imports currently write raw text but do not fetch it back from S3. Keep Block Public Access enabled; the manager receives only short-lived, signed playback URLs for recordings.

S3 uses key prefixes as folders. The default keys are organized like this:

```text
field-source/recordings/YYYY/MM/DD/{recording-id}.webm
field-source/transcripts/YYYY/MM/DD/{transcript-id}/{uploaded-file-name}
```

These are logical S3 prefixes; no empty folder objects need to be created first.

## Bucket CORS

Direct browser uploads and playback require bucket CORS. Replace the origins with the exact deployed PWA and manager origins. Do not use `*` for production origins.

```json
[
  {
    "AllowedOrigins": [
      "http://localhost:5173",
      "http://localhost:5180",
      "http://localhost:4173",
      "http://localhost:4180",
      "https://YOUR-FIELD-PWA.example.com",
      "https://YOUR-MANAGER.example.com"
    ],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type", "x-amz-*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

The PWA's current signed upload sends `Content-Type`; the wildcard also permits future AWS signed headers without opening the bucket to other websites. Keep CORS origins limited to the actual app origins.

## Demo behavior and limits

- The PWA retains its local OPFS copy after upload, so history playback and device storage reporting continue to work.
- The manager dashboard can list and play authentic uploaded captures. Those captures remain separate from the synthetic transcript and chart fixtures.
- The manager accepts plain-text, Markdown, VTT, and SRT transcript files. A deterministic, rule-based pass reports supported demand, objections, availability, competitor mentions, text sentiment cues, outcomes, explicit order values, follow-up language, products, and coaching evidence. Each result links to its transcript line; this is a demo analyzer, not an LLM or production accuracy claim.
- Timings are retained only when provided by VTT/SRT source cues. A conversation date is optional; relative follow-up dates are left unresolved without one.
- Transcript object text is written under `field-source/transcripts`; transcript report metadata is held in memory. Restarting the API clears the manager's report list even though successfully uploaded source text remains in S3.
- Transcription from uploaded audio is not configured in this POC. PWA audio remains at `not_started` until an ASR and analysis provider is connected.
- API visit metadata is held in memory. Restarting the API clears the manager's capture list; the field PWA can re-register its local metadata on the next online sync.
- Uploads use one presigned `PUT` request. This is suitable for normal field recordings and does not implement multipart uploads.
