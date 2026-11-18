# S3 recording upload setup

The field PWA keeps each recording in OPFS first. After the device is online and the visit metadata is registered, the API issues a short-lived presigned S3 `PUT` URL. The PWA uploads the audio bytes directly to the bucket, then asks the API to verify the object size. AWS credentials stay in the API environment and are never shipped to the browser.

## API environment

Copy `apps/api/.env.example` to `apps/api/.env` and set:

| Variable | Required | Purpose |
| --- | --- | --- |
| `AWS_REGION` | Yes | Region containing the bucket. |
| `S3_BUCKET` | Yes | Private bucket name for recordings. |
| `S3_RECORDING_PREFIX` | No | Object key prefix; defaults to `field-source/recordings`. |
| `S3_PRESIGNED_URL_TTL_SECONDS` | No | Upload and playback URL lifetime; defaults to 900 seconds and is limited to 60–3600 seconds. |
| `AWS_PROFILE` | Local dev | Optional shared AWS CLI profile. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | Optional | AWS SDK credential-chain inputs. Prefer a local profile or an IAM role over long-lived keys. |

Use the same region as the bucket. The AWS SDK uses its default credential provider chain, so deployment should use a scoped IAM role. The API reports uploads as configured when a region and bucket are present; an actual upload still requires valid credentials and permissions.

The API role needs `s3:PutObject` and `s3:GetObject` on `arn:aws:s3:::YOUR_BUCKET/YOUR_S3_RECORDING_PREFIX/*` (use the same prefix as `S3_RECORDING_PREFIX`). `GetObject` is used for upload verification and manager playback links. Keep Block Public Access enabled; the manager receives only short-lived, signed playback URLs.

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
- Transcription and insight extraction are not configured in this POC. Uploaded audio will show `not_started` until an ASR and analysis provider is connected.
- API visit metadata is currently held in memory. Restarting the API clears the manager's capture list; the field PWA can re-register its local metadata on the next online sync.
- Uploads use one presigned `PUT` request. This is suitable for normal field recordings and does not implement multipart uploads.
