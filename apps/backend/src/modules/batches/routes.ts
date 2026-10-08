import { Router, type RequestHandler } from 'express';
import { attachMediaRequestSchema, batchListQuerySchema, createBatchRequestSchema, idParamsSchema } from '@rs/shared';
import { parseWith } from '../../core/http';
import type { AuthenticatedRequest } from '../auth';
import type { BatchActor, BatchesService } from './index';

const actorOf = (req: unknown): BatchActor => {
  const { auth } = req as AuthenticatedRequest;
  return { shopId: auth.shopId, userId: auth.userId };
};

// Mount at /api/v1. Every route needs requireAuth; ids of other shops answer 404.
export function createBatchesRouter(service: BatchesService, requireAuth: RequestHandler): Router {
  const router = Router();

  router.post('/batches', requireAuth, async (req, res) => {
    const body = parseWith(createBatchRequestSchema, req.body);
    res.status(201).json(await service.createBatch(actorOf(req), body));
  });

  router.get('/batches', requireAuth, async (req, res) => {
    res.json(await service.listBatches(actorOf(req).shopId, parseWith(batchListQuerySchema, req.query)));
  });

  router.get('/batches/:id', requireAuth, async (req, res) => {
    const { id } = parseWith(idParamsSchema, req.params);
    res.json(await service.getBatch(actorOf(req).shopId, id));
  });

  router.post('/batches/:id/cancel', requireAuth, async (req, res) => {
    const { id } = parseWith(idParamsSchema, req.params);
    res.json(await service.cancel(actorOf(req), id));
  });

  router.post('/batches/:id/retry-failed', requireAuth, async (req, res) => {
    const { id } = parseWith(idParamsSchema, req.params);
    res.json(await service.retryFailed(actorOf(req), id));
  });

  // Adds the ready outputs to the Shopify products they were made for. Without a body it covers every item.
  router.post('/batches/:id/attach-media', requireAuth, async (req, res) => {
    const { id } = parseWith(idParamsSchema, req.params);
    const body = parseWith(attachMediaRequestSchema, req.body ?? {});
    res.json(await service.attachMedia(actorOf(req).shopId, id, body.itemIds));
  });

  return router;
}
