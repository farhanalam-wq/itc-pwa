import { MongoClient } from 'mongodb';
import { createApp } from './app';
import { MongoAdminAuthService } from './auth/admin-auth';
import { createMongoRecordingRepository } from './repositories/mongo-recording-repository';
import { createMongoTranscriptionRepository } from './repositories/mongo-transcription-repository';
import { createMongoConversationAnalysisRepository } from './repositories/mongo-conversation-analysis-repository';
import { DiarizedTranscriptionPipeline } from './services/diarized-transcription';
import { ModalDiarizationClient, readModalDiarizationConfig } from './services/modal-diarization';
import { OpenAITranscriptionWorker } from './services/openai-transcription-worker';
import { ConversationAnalysisWorker } from './services/conversation-analysis-worker';
import { OpenAIConversationAnalyzer } from './services/openai-conversation-analysis';
import { OpenAIAudioTranscriptionProvider, readOpenAITranscriptionConfig } from './services/openai-transcription';
import { readMongoConfig, readStorageConfig } from './services/storage/config';
import { createRecordingStorage } from './services/storage/recording-storage';

const port = Number(Bun.env.PORT ?? 3004);

async function start(): Promise<void> {
  const modalConfig = readModalDiarizationConfig();
  if (!readOpenAITranscriptionConfig().configured) {
    throw new Error('OPENAI_API_KEY is required for speech-to-text on diarized audio clips.');
  }
  if (!Bun.which('ffmpeg')) {
    throw new Error('FFmpeg is required to decode recordings for pyannote diarization.');
  }
  const diarized = new DiarizedTranscriptionPipeline(new ModalDiarizationClient(modalConfig));
  const mongo = readMongoConfig();
  if (!mongo) {
    throw new Error('MONGODB_URI is required to start the API. Set MONGODB_URI and MONGODB_DATABASE in apps/api/.env.');
  }

  const mongoClient = new MongoClient(mongo.uri, { serverSelectionTimeoutMS: 5_000 });
  await mongoClient.connect();
  const database = mongoClient.db(mongo.database);
  const repository = await createMongoRecordingRepository(database);
  const transcriptionJobs = await createMongoTranscriptionRepository(database);
  const conversationAnalyses = await createMongoConversationAnalysisRepository(database);
  const adminAuth = new MongoAdminAuthService(database, {
    cookieSecure: Bun.env.NODE_ENV === 'production'
  });
  await adminAuth.initialize();
  const storage = createRecordingStorage(readStorageConfig());
  const transcriptionWorker = new OpenAITranscriptionWorker(
    transcriptionJobs,
    repository,
    storage,
    new OpenAIAudioTranscriptionProvider(),
    diarized
  );
  const conversationAnalysisWorker = new ConversationAnalysisWorker(
    conversationAnalyses,
    repository,
    transcriptionJobs,
    new OpenAIConversationAnalyzer()
  );
  const app = createApp(repository, undefined, undefined, undefined, storage, adminAuth, transcriptionWorker, transcriptionJobs, conversationAnalyses, conversationAnalysisWorker);

  let draining = false;
  const drainTranscriptionQueue = async () => {
    if (draining) return;
    draining = true;
    try {
      for (const id of await repository.findRecordingsWithoutTranscription()) {
        try {
          await transcriptionWorker.enqueue(id);
        } catch (error) {
          console.error(`Could not queue transcription for recording ${id}:`, error);
        }
      }
      while (true) {
        const result = await transcriptionWorker.runNext();
        if (result.state === 'not_ready' || result.state === 'busy') break;
        if (result.state === 'completed') {
          try {
            await conversationAnalysisWorker.enqueue(result.job.recordingId);
            await conversationAnalysisWorker.runNext(result.job.recordingId);
          } catch (error) {
            console.error(`Could not queue or run conversation analysis for recording ${result.job.recordingId}:`, error);
          }
        }
      }
    } catch (error) {
      console.error('Could not drain the transcription queue:', error);
    }
    try {
      for (const id of await conversationAnalyses.findTranscriptionsWithoutAnalysis()) {
        try {
          await conversationAnalysisWorker.enqueue(id);
        } catch (error) {
          console.error(`Could not queue conversation analysis for recording ${id}:`, error);
        }
      }
      while (true) {
        const result = await conversationAnalysisWorker.runNext();
        if (result.state === 'not_ready' || result.state === 'busy') break;
      }
    } catch (error) {
      console.error('Could not drain the conversation analysis queue:', error);
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
