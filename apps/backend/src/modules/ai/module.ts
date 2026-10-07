import { GoogleAuth } from 'google-auth-library';
import type { AiProviderName, GenerationConfig } from '@rs/shared';
import type { Env } from '../../core/env';
import type { Logger } from '../../core/logger';
import type { AiProvider, AiService } from './index';
import { createAiStudioProvider } from './aistudio';
import { createFakeProvider } from './fake';
import type { HttpContext } from './http';
import { renderPrompt } from './prompts';
import { createVertexProvider } from './vertex';

export interface AiModuleDeps {
  // Only the credentials the providers need. Vertex also reads GOOGLE_APPLICATION_CREDENTIALS through
  // google-auth-library itself.
  env: Pick<Env, 'GOOGLE_CLOUD_PROJECT' | 'GEMINI_API_KEY'>;
  logger: Logger;
  // Defaults to the global fetch. Tests inject a recording fake.
  fetchImpl?: typeof fetch;
  // Read on every fake-provider call, so edits to fake.latencyMs and fake.rateLimitProbability apply live.
  getConfig: () => GenerationConfig;
  // Test hook that replaces the google-auth-library token source used by the Vertex provider.
  getAccessToken?: () => Promise<string>;
}

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

// One GoogleAuth client, created on first use so a missing credentials file only fails Vertex calls.
// The client caches the token and refreshes it before it expires.
function createTokenSource(): () => Promise<string> {
  let auth: GoogleAuth | undefined;
  return async () => {
    auth ??= new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
    const token = await auth.getAccessToken();
    if (typeof token !== 'string' || token.length === 0) throw new Error('google-auth-library returned no access token');
    return token;
  };
}

export function createAiModule(deps: AiModuleDeps): AiService {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const providers = new Map<AiProviderName, AiProvider>();

  const create = (name: AiProviderName): AiProvider => {
    const http = (provider: AiProviderName): HttpContext => ({ provider, fetchImpl, logger: deps.logger });
    switch (name) {
      case 'vertex':
        return createVertexProvider({
          http: http('vertex'),
          project: deps.env.GOOGLE_CLOUD_PROJECT,
          getAccessToken: deps.getAccessToken ?? createTokenSource(),
        });
      case 'aistudio':
        return createAiStudioProvider({ http: http('aistudio'), apiKey: deps.env.GEMINI_API_KEY });
      case 'fake':
        return createFakeProvider({ logger: deps.logger, getConfig: deps.getConfig });
    }
  };

  return {
    getProvider(name) {
      let provider = providers.get(name);
      if (provider === undefined) {
        provider = create(name);
        providers.set(name, provider);
      }
      return provider;
    },
    renderPrompt,
  };
}
