import { createMockApi } from '@rs/mock-api';
import type { NextRequest } from 'next/server';
import { errorResponse, handleMockRequest, type MockResponse } from '@/lib/mock/routes';

// The in-memory API for NEXT_PUBLIC_MOCK=1. In real mode the rewrite in next.config.ts forwards /api/v1/* to the
// backend before this file is reached, and the guard below answers 404 should it ever be.
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

function toResponse({ status, body }: MockResponse): Response {
  if (status === 204 || body === undefined) return new Response(null, { status, headers: NO_STORE });
  return Response.json(body, { status, headers: NO_STORE });
}

async function readBody(request: NextRequest): Promise<unknown> {
  if (request.method !== 'POST') return undefined;
  try {
    return (await request.json()) as unknown;
  } catch {
    return undefined;
  }
}

async function handle(request: NextRequest): Promise<Response> {
  if (process.env.NEXT_PUBLIC_MOCK !== '1') return toResponse(errorResponse('not_found', 'Not found'));
  const url = new URL(request.url);
  return toResponse(
    await handleMockRequest(createMockApi(), {
      method: request.method,
      pathname: url.pathname,
      query: url.searchParams,
      body: await readBody(request),
      authorization: request.headers.get('authorization'),
    }),
  );
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
