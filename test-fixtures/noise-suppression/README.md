# Running the noise suppression fixtures

The fixture runner is development-only at `http://127.0.0.1:5173/__noise-fixtures`. It is removed from production builds. Select one or more WAV files from the `conversation_001` directory; the runner processes them serially in clean, 80%, 100%, 125%, 150% order.

The runner requires a secure AudioWorklet-capable browser. It plays each WAV through the existing DeepFilterNet service in real time, retains the untouched WAV as the original artifact, and uploads the recorded 48 kHz processed stream as the analysis sidecar. The API then runs Modal/Pyannote diarization, OpenAI transcription, and conversation analysis.

Use an isolated local database and local file storage:

1. Start MongoDB in a temporary test directory on port 27028:

   ```sh
   mkdir -p /tmp/itc-noise-fixture-mongo
   mongod --bind_ip 127.0.0.1 --port 27028 --dbpath /tmp/itc-noise-fixture-mongo
   ```

2. Start the API from `apps/api` with its existing Modal/OpenAI provider configuration and isolated persistence:

   ```sh
   MONGODB_URI=mongodb://127.0.0.1:27028 MONGODB_DATABASE=noise_fixture_test \
   STORAGE_DRIVER=local LOCAL_RECORDING_DIR=/tmp/itc-noise-fixture-recordings \
   LOCAL_UPLOAD_STAGING_DIR=/tmp/itc-noise-fixture-staging bun src/index.ts
   ```

3. Start the Field PWA dev server from `apps/field-pwa` with `bun run dev`, open the runner URL above, and select the fixtures.

Each fixture creates a synthetic test visit in that local database and invokes the configured Modal/OpenAI providers. Provider calls can incur usage charges. Audio and database files stay under `/tmp`; stop the services with Ctrl+C when finished.

The transcript and scenario reference are synthetic evaluation aids, not verified gold labels. Confirm transcript alignment before calculating WER/CER, and require transcript evidence before treating an expected business fact as confirmed.
