import { PromptStateModel, PromptVersionModel } from './models';
import { createPromptsRouter } from './routes';
import { createPromptsService } from './service';
import type { PromptsModule, PromptsModuleOptions } from './index';

// Wire once at boot, after the auth module and the config service exist:
//   const prompts = createPromptsModule({ requireAuth: auth.requireAuth, getGlobalPrompt: (n) => config.getPrompt(n), logger });
//   app.use('/api/v1', prompts.router);            // the per-store prompt editor API
//   batches use prompts.service.activeRefs at creation; generation uses prompts.service.resolve at job time;
//   shop/redact calls prompts.service.purgeShop; prompts.ensureIndexes() once after the Mongo connection.
export function createPromptsModule(options: PromptsModuleOptions): PromptsModule {
  const service = createPromptsService(options);
  return {
    service,
    router: createPromptsRouter(service, options.requireAuth),
    async ensureIndexes() {
      await Promise.all([PromptVersionModel.createIndexes(), PromptStateModel.createIndexes()]);
    },
  };
}
