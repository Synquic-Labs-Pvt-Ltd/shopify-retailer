import {
  ApiError,
  PROMPT_DEFINITIONS,
  PROMPT_MAX_VERSIONS,
  PROMPT_NAMES,
  PROMPT_NOTE_MAX_CHARS,
  validatePromptText,
  type ActivatePromptRequest,
  type PromptDetail,
  type PromptListResponse,
  type PromptName,
  type PromptSummary,
  type PromptVersionInfo,
  type PromptVersionText,
  type SavePromptRequest,
} from '@rs/shared';

// Per-store prompt versions in mock mode (SPEC 12.6). Version 0 is the global default and is always there; every
// save adds the next number (1, 2, ...) and makes it the active one. Activating any version, 0 included, switches
// back and forth without losing anything. The mock serves one shop, so there is one state per prompt.

// Short stand-ins for the real files in apps/backend/config/prompts. Each one passes validatePromptText.
export const GLOBAL_PROMPT_TEXTS: Readonly<Record<PromptName, string>> = {
  'planner.system': [
    'You are the creative director of a product photography and video studio for online stores.',
    '',
    'You receive product data, the product photos and sometimes style references. Plan exactly {{imageCount}} still image shots and exactly {{videoCount}} video shots that show this exact product in realistic, aspirational settings.',
    '',
    '{{styleGuidance}}',
    '',
    'Rules:',
    '1. Product fidelity is absolute: never plan a shot that changes, recolors or hides part of the product.',
    '2. Write a mustPreserve checklist with one specific entry per visible piece or distinctive detail.',
    '3. Every shot is a new photograph: its own pose, angle, framing and light, in the same visual world.',
    '4. Video shots are a single continuous take of {{videoDurationSeconds}} seconds, {{videoAspectRatio}}, with one simple, steady camera move.',
    '5. Keep everything wholesome and family-friendly. Output only JSON that matches the provided schema.',
  ].join('\n'),
  'image.user': [
    'Create one photorealistic photograph for an online store. This is a fresh photoshoot, not a copy of the product images.',
    '',
    'Shot: {{shot.prompt}}',
    'Camera and framing: {{shot.camera}}',
    'Lighting: {{shot.lighting}}',
    'People: {{shot.people}}',
    '',
    'Product fidelity (highest priority): reproduce the product exactly as in the product images. Preserve: {{plan.product.mustPreserve}}.',
    '',
    'Output: a single image, {{image.aspectRatio}} aspect ratio, no text, no watermark.',
    'Avoid: {{shot.negative}}, distorted product, changed garment, duplicate products.',
  ].join('\n'),
  'video.user': [
    '{{shot.prompt}} Camera: {{shot.cameraMove}}, single continuous shot, smooth and steady.',
    'Action: {{shot.subjectAction}}. Lighting: {{shot.lighting}}.',
    'The product stays identical for the entire video: {{plan.product.mustPreserve}}.',
    'Real footage look, no on-screen text, captions or watermarks.',
  ].join('\n'),
};

// The versions the next generation of the shop would use. 0 is the global default.
export interface ActivePromptVersions {
  planner: number;
  image: number;
  video: number;
}

export interface MockPromptStore {
  list(): PromptListResponse;
  get(name: PromptName): PromptDetail;
  getVersion(name: PromptName, version: number): PromptVersionText;
  // Saves the text as the next version and makes it active. The text that is already active is a no-op.
  save(name: PromptName, body: SavePromptRequest): PromptDetail;
  activate(name: PromptName, body: ActivatePromptRequest): PromptDetail;
  activeVersions(): ActivePromptVersions;
}

interface StoredVersion {
  version: number;
  text: string;
  note: string | null;
  createdAt: string;
}

interface PromptState {
  // Oldest first; version numbers are 1..n without gaps.
  versions: StoredVersion[];
  active: number;
}

function validationFailed(errors: string[]): ApiError {
  return new ApiError(400, 'validation_failed', errors[0] ?? 'The prompt is not valid.', { errors });
}

export function createMockPromptStore(): MockPromptStore {
  const states = new Map<PromptName, PromptState>(
    PROMPT_NAMES.map((name): [PromptName, PromptState] => [name, { versions: [], active: 0 }]),
  );

  const stateOf = (name: PromptName): PromptState => {
    const state = states.get(name);
    if (state === undefined) throw new ApiError(404, 'not_found', 'Prompt not found');
    return state;
  };

  // Version 0 is the global default, any other number a version this store saved.
  const entryOf = (name: PromptName, version: number): StoredVersion | undefined =>
    stateOf(name).versions.find((entry) => entry.version === version);

  const textOf = (name: PromptName, version: number): string | undefined =>
    version === 0 ? GLOBAL_PROMPT_TEXTS[name] : entryOf(name, version)?.text;

  const infoOf = (name: PromptName, version: number): PromptVersionInfo | undefined => {
    const active = stateOf(name).active === version;
    if (version === 0) {
      return { version: 0, source: 'global', createdAt: null, note: null, chars: GLOBAL_PROMPT_TEXTS[name].length, active };
    }
    const entry = entryOf(name, version);
    if (entry === undefined) return undefined;
    return { version, source: 'store', createdAt: entry.createdAt, note: entry.note, chars: entry.text.length, active };
  };

  const summaryOf = (name: PromptName): PromptSummary => {
    const definition = PROMPT_DEFINITIONS[name];
    const { versions, active } = stateOf(name);
    return {
      name,
      title: definition.title,
      description: definition.description,
      placeholders: definition.placeholders.map((placeholder) => ({ ...placeholder })),
      activeVersion: active,
      latestVersion: versions.at(-1)?.version ?? 0,
      isCustom: active !== 0,
      updatedAt: entryOf(name, active)?.createdAt ?? null,
    };
  };

  const detailOf = (name: PromptName): PromptDetail => {
    const { versions, active } = stateOf(name);
    // Newest first, the global default (version 0) last.
    const order = [...versions.map((entry) => entry.version).reverse(), 0];
    return {
      ...summaryOf(name),
      text: textOf(name, active) ?? GLOBAL_PROMPT_TEXTS[name],
      globalText: GLOBAL_PROMPT_TEXTS[name],
      versions: order.flatMap((version) => infoOf(name, version) ?? []),
    };
  };

  return {
    list: () => ({ items: PROMPT_NAMES.map(summaryOf) }),

    get: detailOf,

    getVersion: (name, version) => {
      const text = textOf(name, version);
      const info = infoOf(name, version);
      if (text === undefined || info === undefined) throw new ApiError(404, 'not_found', 'Prompt version not found');
      return { ...info, text };
    },

    save: (name, body) => {
      const state = stateOf(name);
      const checked = validatePromptText(name, body.text);
      if (!checked.ok) throw validationFailed(checked.errors);
      const note = body.note?.trim() ?? '';
      if (note.length > PROMPT_NOTE_MAX_CHARS) {
        throw validationFailed([`The note is too long: ${note.length} characters, the limit is ${PROMPT_NOTE_MAX_CHARS}.`]);
      }
      if (checked.text === textOf(name, state.active)) return detailOf(name);
      if (state.versions.length >= PROMPT_MAX_VERSIONS) {
        throw new ApiError(
          429,
          'shop_limit',
          `This prompt already has ${PROMPT_MAX_VERSIONS} versions. Switch to an older version and edit that, or contact support.`,
        );
      }
      const version = (state.versions.at(-1)?.version ?? 0) + 1;
      state.versions.push({
        version,
        text: checked.text,
        note: note === '' ? null : note,
        createdAt: new Date().toISOString(),
      });
      state.active = version;
      return detailOf(name);
    },

    activate: (name, body) => {
      if (textOf(name, body.version) === undefined) throw new ApiError(404, 'not_found', 'Prompt version not found');
      stateOf(name).active = body.version;
      return detailOf(name);
    },

    activeVersions: () => ({
      planner: stateOf('planner.system').active,
      image: stateOf('image.user').active,
      video: stateOf('video.user').active,
    }),
  };
}
