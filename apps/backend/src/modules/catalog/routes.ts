import { Router, type Request, type RequestHandler } from 'express';
import { productGidParamsSchema, productListQuerySchema } from '@rs/shared';
import { AppError } from '../../core/errors';
import { parseWith } from '../../core/http';
import type { AuthContext, AuthenticatedRequest } from '../auth';
import type { ProductsService } from './products-service';

function authOf(req: Request): AuthContext {
  const { auth } = req as Partial<AuthenticatedRequest>;
  if (auth === undefined) throw AppError.unauthorized();
  return auth;
}

// Paths are relative to /api/v1. Every route is tenant scoped through req.auth.shopId.
export function createCatalogRouter(products: ProductsService, requireAuth: RequestHandler): Router {
  const router = Router();

  router.get('/products', requireAuth, async (req, res) => {
    const query = parseWith(productListQuerySchema, req.query);
    res.json(await products.list(authOf(req).shopId, query));
  });

  router.get('/products/:gid', requireAuth, async (req, res) => {
    const { gid } = parseWith(productGidParamsSchema, req.params);
    res.json(await products.get(authOf(req).shopId, gid));
  });

  return router;
}
