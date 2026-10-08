// Liveness check for the host (container health check). It does not call the backend.
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ ok: true });
}
