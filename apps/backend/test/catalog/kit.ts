import express, { type Express, type RequestHandler } from 'express';
import { pino } from 'pino';
import { createErrorHandler } from '../../src/core/errors';
import type { AuthenticatedRequest } from '../../src/modules/auth';
import type { ShopifyAdminClient } from '../../src/modules/shopify';

export const silentLogger = pino({ level: 'silent' });

export interface RecordedCall {
  shopId: string;
  query: string;
  variables: Record<string, unknown> | undefined;
}

export interface MockAdmin {
  admin: ShopifyAdminClient;
  calls: RecordedCall[];
}

// A ShopifyAdminClient whose answer is chosen by the test from the query text.
export function createMockAdmin(respond: (call: RecordedCall) => unknown): MockAdmin {
  const calls: RecordedCall[] = [];
  const admin: ShopifyAdminClient = {
    async query<TData>(shopId: string, query: string, variables?: Record<string, unknown>) {
      const call: RecordedCall = { shopId, query, variables };
      calls.push(call);
      return { data: respond(call) as TData, cost: null };
    },
  };
  return { admin, calls };
}

export const SHOP_ID = 'a'.repeat(24);
export const USER_ID = 'b'.repeat(24);

// Stands in for auth.requireAuth: reads the tenant from test headers and rejects without them.
export const fakeRequireAuth: RequestHandler = (req, res, next) => {
  const shopId = req.header('x-test-shop');
  if (shopId === undefined) {
    res.status(401).json({ error: { code: 'unauthorized', message: 'Authentication required' } });
    return;
  }
  const withAuth = req as AuthenticatedRequest;
  withAuth.auth = { userId: req.header('x-test-user') ?? USER_ID, shopId, shopDomain: `${shopId.slice(0, 6)}.myshopify.com` };
  next();
};

export function createTestApp(mount: (app: Express) => void): Express {
  const app = express();
  app.use(express.json());
  mount(app);
  app.use(createErrorHandler(silentLogger));
  return app;
}

export function productGid(n: number): string {
  return `gid://shopify/Product/${n}`;
}
