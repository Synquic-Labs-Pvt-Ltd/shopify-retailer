import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// mongod needs about 20 s to start on a Windows host with Defender scanning, so the default 10 s
// launch timeout is too short. Use this timeout as the beforeAll timeout as well.
// Set MONGOMS_DOWNLOAD_DIR to keep the downloaded mongod binary in a stable cache directory.
export const MONGO_START_TIMEOUT_MS = 120_000;

export interface TestMongo {
  uri: string;
  // Deletes every document in every collection and keeps the indexes.
  clear(): Promise<void>;
  stop(): Promise<void>;
}

// Starts an in-memory mongod and connects the default mongoose connection to it.
// Vitest isolates test files, so each file gets its own server and connection.
export async function startTestMongo(dbName = 'rs_test'): Promise<TestMongo> {
  const server = await MongoMemoryServer.create({ instance: { launchTimeout: MONGO_START_TIMEOUT_MS, dbName } });
  const uri = server.getUri(dbName);
  await mongoose.connect(uri);
  return {
    uri,
    async clear() {
      const db = mongoose.connection.db;
      if (!db) return;
      const collections = await db.collections();
      await Promise.all(collections.map((collection) => collection.deleteMany({})));
    },
    async stop() {
      await mongoose.disconnect();
      await server.stop();
    },
  };
}
