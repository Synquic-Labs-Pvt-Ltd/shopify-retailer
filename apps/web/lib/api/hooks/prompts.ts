import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ActivatePromptRequest, PromptDetail, PromptName, SavePromptRequest } from '@rs/shared';
import { promptEndpoints } from '../endpoints';
import { queryKeys } from '../keys';

// GET /api/v1/prompts: the three prompts with the version each one runs on.
export function usePrompts() {
  return useQuery({ queryKey: queryKeys.prompts.list, queryFn: () => promptEndpoints.list() });
}

// GET /api/v1/prompts/:name: the active text, the global default text and every version.
export function usePrompt(name: PromptName) {
  return useQuery({ queryKey: queryKeys.prompts.detail(name), queryFn: () => promptEndpoints.get(name) });
}

// GET /api/v1/prompts/:name/versions/:version. A saved version never changes, so it is read once. `enabled` is off
// while nothing is being viewed, or when the text is already at hand (the active version and the global default).
export function usePromptVersion(name: PromptName, version: number | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.prompts.version(name, version ?? -1),
    queryFn: () => promptEndpoints.getVersion(name, version ?? 0),
    enabled: enabled && version !== null,
    staleTime: Infinity,
  });
}

// A save and an activation both answer with the new detail of the prompt: it goes straight into the cache of that
// prompt, and the list (which shows the active version of every prompt) is refetched.
function usePromptWrite<TBody>(name: PromptName, write: (name: PromptName, body: TBody) => Promise<PromptDetail>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: TBody) => write(name, body),
    // Never repeated automatically: every save adds a version.
    retry: false,
    onSuccess: (detail) => {
      queryClient.setQueryData(queryKeys.prompts.detail(name), detail);
      void queryClient.invalidateQueries({ queryKey: queryKeys.prompts.list });
    },
  });
}

// PUT /api/v1/prompts/:name: the text becomes the next version and the active one.
export function useSavePrompt(name: PromptName) {
  return usePromptWrite<SavePromptRequest>(name, (promptName, body) => promptEndpoints.save(promptName, body));
}

// POST /api/v1/prompts/:name/activate: a saved version becomes the active one again; version 0 is the global default.
export function useActivatePrompt(name: PromptName) {
  return usePromptWrite<ActivatePromptRequest>(name, (promptName, body) => promptEndpoints.activate(promptName, body));
}
