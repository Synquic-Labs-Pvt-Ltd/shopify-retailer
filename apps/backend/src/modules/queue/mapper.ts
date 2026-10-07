import type { QueueJob } from './index';
import type { JobDoc } from './models';

export function toQueueJob(doc: JobDoc): QueueJob {
  const operation = doc.operation;
  const output = doc.output;
  const error = doc.error;
  return {
    id: doc._id.toHexString(),
    shopId: doc.shopId.toHexString(),
    batchId: doc.batchId.toHexString(),
    batchItemId: doc.batchItemId.toHexString(),
    type: doc.type,
    lane: doc.lane,
    status: doc.status,
    dependsOn: doc.dependsOn.map((id) => id.toHexString()),
    outputIndex: doc.outputIndex ?? null,
    priority: doc.priority,
    runAt: doc.runAt,
    attempts: doc.attempts,
    maxAttempts: doc.maxAttempts,
    deferrals: doc.deferrals,
    operation:
      operation?.name !== undefined && operation.submittedAt !== undefined && operation.nextPollAt !== undefined
        ? {
            name: operation.name,
            submittedAt: operation.submittedAt,
            nextPollAt: operation.nextPollAt,
            polls: operation.polls ?? 0,
          }
        : null,
    promptVersion: doc.promptVersion ?? null,
    renderedPrompt: doc.renderedPrompt ?? null,
    output:
      output === undefined
        ? null
        : {
            mediaAssetId: output.mediaAssetId?.toHexString() ?? null,
            providerResponseId: output.providerResponseId ?? null,
            modelVersion: output.modelVersion ?? null,
          },
    error:
      error?.code !== undefined && error.at !== undefined
        ? {
            code: error.code,
            message: error.message ?? '',
            ...(error.providerReason === undefined ? {} : { providerReason: error.providerReason }),
            ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
            retryable: error.retryable ?? false,
            at: error.at,
          }
        : null,
    createdAt: doc.createdAt,
    startedAt: doc.startedAt ?? null,
    finishedAt: doc.finishedAt ?? null,
  };
}
