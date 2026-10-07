import mongoose from 'mongoose';

// The queue module owns the jobs collection; the governor only needs this count, so it reads the
// collection by name instead of importing the queue's model. Served by the { status, lane, ... } index.
export function createDefaultInFlightCounter(): (lane: string) => Promise<number> {
  return (lane) =>
    mongoose.connection.collection('jobs').countDocuments({ lane, status: { $in: ['running', 'awaiting_operation'] } });
}
