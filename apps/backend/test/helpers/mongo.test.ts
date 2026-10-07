import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MONGO_START_TIMEOUT_MS, startTestMongo, type TestMongo } from './mongo';

let mongo: TestMongo;

beforeAll(async () => {
  mongo = await startTestMongo();
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await mongo.stop();
});

describe('test mongo helper', () => {
  it('connects, writes, and clears', async () => {
    const things = mongoose.connection.collection('things');
    await things.insertOne({ a: 1 });
    expect(await things.countDocuments()).toBe(1);
    await mongo.clear();
    expect(await things.countDocuments()).toBe(0);
  });
});
