import { MongoClient } from 'mongodb';
import { createApp } from './app';
import { createMongoRecordingRepository } from './repositories/mongo-recording-repository';
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
  const repository = await createMongoRecordingRepository(mongoClient.db(mongo.database));
  const storage = createRecordingStorage(readStorageConfig());
  const app = createApp(repository, undefined, undefined, undefined, storage);

  app.onStop(() => mongoClient.close());
  app.listen(port);
  console.log(`ITC Field Source API listening on port ${port} (MongoDB, ${storage.driver} storage)`);
}

await start();
