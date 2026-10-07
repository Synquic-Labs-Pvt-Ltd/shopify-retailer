import { Router, type Request, type RequestHandler } from 'express';
import { idParamsSchema, mediaListQuerySchema, uploadsRequestSchema } from '@rs/shared';
import type { MediaListResponse, UploadsResponse } from '@rs/shared';
import { AppError } from '../../core/errors';
import { parseWith } from '../../core/http';
import type { AuthContext, AuthenticatedRequest } from '../auth';
import type { MediaService } from './index';

function authOf(req: Request): AuthContext {
  const { auth } = req as Partial<AuthenticatedRequest>;
  if (auth === undefined) throw AppError.unauthorized();
  return auth;
}

// Paths are relative to /api/v1. Every route is tenant scoped through req.auth.shopId; media ids from
// the client are always looked up together with the shop.
export function createMediaRouter(service: MediaService, requireAuth: RequestHandler): Router {
  const router = Router();

  router.post('/media/uploads', requireAuth, async (req, res) => {
    const { files } = parseWith(uploadsRequestSchema, req.body);
    const { shopId, userId } = authOf(req);
    const targets = await service.storage.createUploadTargets({ shopId, userId }, files);
    const body: UploadsResponse = { targets };
    res.json(body);
  });

  router.post('/media/:id/complete', requireAuth, async (req, res) => {
    const { id } = parseWith(idParamsSchema, req.params);
    const { shopId, userId } = authOf(req);
    res.json(await service.storage.completeUpload({ shopId, userId }, id));
  });

  router.get('/media', requireAuth, async (req, res) => {
    const { ids } = parseWith(mediaListQuerySchema, req.query);
    const body: MediaListResponse = { items: await service.getObjects(authOf(req).shopId, ids, { refresh: true }) };
    res.json(body);
  });

  router.delete('/media/:id', requireAuth, async (req, res) => {
    const { id } = parseWith(idParamsSchema, req.params);
    await service.deleteReference(authOf(req).shopId, id);
    res.status(204).end();
  });

  return router;
}
