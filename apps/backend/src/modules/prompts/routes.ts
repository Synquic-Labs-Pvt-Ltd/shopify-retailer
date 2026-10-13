import { Router, type Request, type RequestHandler } from 'express';
import {
  activatePromptRequestSchema,
  promptNameSchema,
  promptVersionParamsSchema,
  savePromptRequestSchema,
} from '@rs/shared';
import { z } from 'zod';
import { AppError } from '../../core/errors';
import { parseWith } from '../../core/http';
import type { AuthContext, AuthenticatedRequest } from '../auth';
import type { PromptsService } from './index';

const nameParamsSchema = z.object({ name: promptNameSchema });

function authOf(req: Request): AuthContext {
  const { auth } = req as Partial<AuthenticatedRequest>;
  if (auth === undefined) throw AppError.unauthorized();
  return auth;
}

// Paths are relative to /api/v1. Every route is tenant scoped through req.auth.shopId: a store only ever reads and
// edits its own prompts, and the global defaults are read-only here.
export function createPromptsRouter(service: PromptsService, requireAuth: RequestHandler): Router {
  const router = Router();

  router.get('/prompts', requireAuth, async (req, res) => {
    res.json(await service.list(authOf(req).shopId));
  });

  router.get('/prompts/:name', requireAuth, async (req, res) => {
    const { name } = parseWith(nameParamsSchema, req.params);
    res.json(await service.get(authOf(req).shopId, name));
  });

  router.get('/prompts/:name/versions/:version', requireAuth, async (req, res) => {
    const { name, version } = parseWith(promptVersionParamsSchema, req.params);
    res.json(await service.getVersion(authOf(req).shopId, name, version));
  });

  router.put('/prompts/:name', requireAuth, async (req, res) => {
    const { name } = parseWith(nameParamsSchema, req.params);
    const body = parseWith(savePromptRequestSchema, req.body);
    const auth = authOf(req);
    res.json(await service.save({ shopId: auth.shopId, userId: auth.userId }, name, { text: body.text, note: body.note }));
  });

  router.post('/prompts/:name/activate', requireAuth, async (req, res) => {
    const { name } = parseWith(nameParamsSchema, req.params);
    const body = parseWith(activatePromptRequestSchema, req.body);
    const auth = authOf(req);
    res.json(await service.activate({ shopId: auth.shopId, userId: auth.userId }, name, body.version));
  });

  return router;
}
