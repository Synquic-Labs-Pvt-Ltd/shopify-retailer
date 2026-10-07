// Every TanStack Query key in one place, so invalidation and cache seeding never drift apart.
export const queryKeys = {
  me: ['me'] as const,
  products: {
    all: ['products'] as const,
    list: (search: string) => ['products', 'list', search] as const,
  },
  media: {
    all: ['media'] as const,
    status: (ids: readonly string[]) => ['media', 'status', ...ids] as const,
  },
  batches: {
    all: ['batches'] as const,
    list: () => ['batches', 'list'] as const,
    detail: (id: string) => ['batches', 'detail', id] as const,
  },
} as const;
