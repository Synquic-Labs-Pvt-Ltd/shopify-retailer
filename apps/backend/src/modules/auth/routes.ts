import { Router, type Request, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import {
  authExchangeRequestSchema,
  authLogoutRequestSchema,
  authRefreshRequestSchema,
  pkceChallengeSchema,
  shopifyCallbackQuerySchema,
  shopifyLandingQuerySchema,
  type GenerationConfig,
  type MeResponse,
} from '@rs/shared';
import { AppError } from '../../core/errors';
import { parseWith } from '../../core/http';
import type { ShopsService } from '../shops';
import { verifyOAuthQueryHmac } from './hmac';
import type { AuthenticatedRequest } from './index';
import { renderInstalledPage } from './landing';
import { UserModel, type UserDoc } from './models';
import { parseShopInput, type AuthEnv, type OAuthFlow } from './oauth-flow';
import { toShopDto, toUserDto, type SessionService } from './sessions';

const startQuerySchema = z.object({
  shop: z.string().trim().min(1).max(255),
  challenge: pkceChallengeSchema,
});

export interface AuthRoutesDeps {
  env: AuthEnv;
  shops: Pick<ShopsService, 'getById'>;
  flow: OAuthFlow;
  sessions: SessionService;
  requireAuth: RequestHandler;
  getGenerationConfig: () => GenerationConfig;
  // Requests per minute per IP on the auth routes. Default 30 (SPEC 18).
  rateLimitPerMinute?: number;
}

export interface AuthRouters {
  // Mount at the root: GET /, GET /auth/shopify/start, GET /auth/shopify/callback.
  browserRouter: Router;
  // Mount at /api/v1: POST /auth/exchange, /auth/refresh, /auth/logout and GET /me.
  apiRouter: Router;
}

function rawQuery(req: Request): string {
  const index = req.originalUrl.indexOf('?');
  return index === -1 ? '' : req.originalUrl.slice(index + 1);
}

const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('cache-control', 'no-store');
  next();
};

export function createAuthRouters(deps: AuthRoutesDeps): AuthRouters {
  const { env, shops, flow, sessions, requireAuth } = deps;

  const limiter = rateLimit({
    windowMs: 60_000,
    limit: deps.rateLimitPerMinute ?? 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new AppError('too_many_requests', 'Too many requests, try again in a minute')),
  });

  const browserRouter = Router();
  browserRouter.use(noStore);

  browserRouter.get('/auth/shopify/start', limiter, async (req, res) => {
    const query = parseWith(startQuerySchema, req.query);
    res.redirect(302, await flow.start(parseShopInput(query.shop), query.challenge));
  });

  browserRouter.get('/auth/shopify/callback', limiter, async (req, res) => {
    const query = parseWith(shopifyCallbackQuerySchema, req.query);
    const result = await flow.callback(rawQuery(req), query);
    if (result.kind === 'redirect') {
      res.redirect(302, result.location);
      return;
    }
    res.status(200).type('html').send(renderInstalledPage(result.shopDomain));
  });

  // App URL: Shopify opens it after install or from the admin (SPEC 8.3 step 8).
  browserRouter.get('/', async (req, res) => {
    const query = parseWith(shopifyLandingQuerySchema, req.query);
    if (!verifyOAuthQueryHmac(rawQuery(req), env.SHOPIFY_API_SECRET)) {
      throw AppError.forbidden('Invalid request signature');
    }
    const authorizeUrl = await flow.landing(query.shop);
    if (authorizeUrl !== null) {
      res.redirect(302, authorizeUrl);
      return;
    }
    res.status(200).type('html').send(renderInstalledPage(query.shop));
  });

  const apiRouter = Router();
  apiRouter.use(noStore);

  apiRouter.post('/auth/exchange', limiter, async (req, res) => {
    res.json(await sessions.exchange(parseWith(authExchangeRequestSchema, req.body)));
  });

  apiRouter.post('/auth/refresh', limiter, async (req, res) => {
    res.json(await sessions.refresh(parseWith(authRefreshRequestSchema, req.body).refreshToken));
  });

  // The refresh token is the credential, so an expired access token must not block logout.
  apiRouter.post('/auth/logout', limiter, async (req, res) => {
    await sessions.logout(parseWith(authLogoutRequestSchema, req.body).refreshToken);
    res.status(204).end();
  });

  apiRouter.get('/me', requireAuth, async (req, res) => {
    const { auth } = req as AuthenticatedRequest;
    const [user, shop] = await Promise.all([UserModel.findById(auth.userId).lean<UserDoc>(), shops.getById(auth.shopId)]);
    if (user === null || shop === null) throw AppError.unauthorized();

    const config = deps.getGenerationConfig();
    const body: MeResponse = {
      user: toUserDto(user),
      shop: toShopDto(shop),
      generation: {
        imagesPerProduct: config.outputs.imagesPerProduct,
        videosPerProduct: config.outputs.videosPerProduct,
        references: config.references,
        maxProductsPerBatch: config.batch.maxProductsPerBatch,
      },
    };
    res.json(body);
  });

  return { browserRouter, apiRouter };
}
