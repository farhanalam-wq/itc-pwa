import { MongoClient } from 'mongodb';
import { createApp } from './app';
import { MongoAdminAuthService, readAdminSetupToken } from './auth/admin-auth';
import { createMongoRecordingRepository } from './repositories/mongo-recording-repository';
import { createMongoTranscriptionRepository } from './repositories/mongo-transcription-repository';
import { OpenAITranscriptionWorker } from './services/openai-transcription-worker';
import { OpenAIAudioTranscriptionProvider } from './services/openai-transcription';
import { readMongoConfig, readStorageConfig } from './services/storage/config';
import { createRecordingStorage } from './services/storage/recording-storage';

const port = Number(Bun.env.PORT ?? 3004);

async function start(): Promise<void> {
  const mongo = readMongoConfig();
  if (!mongo) {
    throw new Error('MONGODB_URI is required to start the API. Set MONGODB_URI and MONGODB_DATABASE in apps/api/.env.');
  }

  const mongoClient = new MongoClient(mongo.uri, { serverSelectionTimeoutMS: 5_000 });
  await mongoClient.connect();
  const database = mongoClient.db(mongo.database);
  const repository = await createMongoRecordingRepository(database);
  const transcriptionJobs = await createMongoTranscriptionRepository(database);
  const adminAuth = new MongoAdminAuthService(database, readAdminSetupToken(), {
    cookieSecure: Bun.env.NODE_ENV === 'production'
  });
  await adminAuth.initialize();
  const storage = createRecordingStorage(readStorageConfig());
  const transcriptionWorker = new OpenAITranscriptionWorker(
    transcriptionJobs,
    repository,
    storage,
    new OpenAIAudioTranscriptionProvider()
  );
  const app = createApp(repository, undefined, undefined, undefined, storage, adminAuth, transcriptionWorker, transcriptionJobs);

  let draining = false;
  const drainTranscriptionQueue = async () => {
    if (draining) return;
    draining = true;
    try {
      while (true) {
        const result = await transcriptionWorker.runNext();
        if (result.state === 'not_ready' || result.state === 'busy') break;
      }
    } catch (error) {
      console.error('Could not drain the transcription queue:', error);
    } finally {
      draining = false;
    }
  };
  void drainTranscriptionQueue();
  const transcriptionInterval = setInterval(() => { void drainTranscriptionQueue(); }, 60_000);
  app.onStop(async () => {
    clearInterval(transcriptionInterval);
    await mongoClient.close();
  });
  app.listen(port);
  console.log(`ITC Field Source API listening on port ${port} (MongoDB, ${storage.driver} storage)`);
}

await start();
