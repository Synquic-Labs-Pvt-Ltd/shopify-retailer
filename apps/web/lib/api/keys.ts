import type { PromptName } from '@rs/shared';

// Every TanStack Query key in one place, so invalidation and cache seeding never drift apart.
export const queryKeys = {
  me: ['me'] as const,
  prompts: {
    all: ['prompts'] as const,
    list: ['prompts', 'list'] as const,
    detail: (name: PromptName) => ['prompts', 'detail', name] as const,
    version: (name: PromptName, version: number) => ['prompts', 'version', name, version] as const,
  },
  products: {
    all: ['products'] as const,
    list: (search: string, status: string) => ['products', 'list', search, status] as const,
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
