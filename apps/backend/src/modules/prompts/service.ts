import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import {
  PROMPT_DEFINITIONS,
  PROMPT_MAX_VERSIONS,
  PROMPT_NAMES,
  validatePromptText,
  type PromptDetail,
  type PromptName,
  type PromptSummary,
  type PromptVersionInfo,
} from '@rs/shared';
import { AppError } from '../../core/errors';
import { PromptStateModel, PromptVersionModel, type PromptStateDoc, type PromptVersionDoc } from './models';
import type { PromptActor, PromptRefs, PromptsModuleOptions, PromptsService, ResolvedPrompt } from './index';

// Versions never change once saved, so a resolved one can be kept for good. The cache only needs a bound.
const CACHE_LIMIT = 500;

const hashText = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12);

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 11000;
}

export function createPromptsService(options: PromptsModuleOptions): PromptsService {
  const { getGlobalPrompt, logger } = options;
  const now = options.now ?? (() => new Date());

  const cache = new Map<string, ResolvedPrompt>();
  const remember = (key: string, value: ResolvedPrompt): void => {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
    cache.set(key, value);
  };

  const shopObjectId = (shopId: string): Types.ObjectId => new Types.ObjectId(shopId);

  const globalResolved = (name: PromptName): ResolvedPrompt => {
    const prompt = getGlobalPrompt(name);
    return { name, text: prompt.text, hash: prompt.version, version: 0, source: 'global' };
  };

  async function stateOf(shopId: string, name: PromptName): Promise<PromptStateDoc | null> {
    return PromptStateModel.findOne({ shopId: shopObjectId(shopId), name }).lean<PromptStateDoc>();
  }

  async function versionDoc(shopId: string, name: PromptName, version: number): Promise<PromptVersionDoc | null> {
    return PromptVersionModel.findOne({ shopId: shopObjectId(shopId), name, version }).lean<PromptVersionDoc>();
  }

  async function textOf(shopId: string, name: PromptName, version: number): Promise<string | null> {
    if (version === 0) return getGlobalPrompt(name).text;
    return (await versionDoc(shopId, name, version))?.text ?? null;
  }

  function summaryOf(name: PromptName, state: PromptStateDoc | null, activeAt: Date | null): PromptSummary {
    const definition = PROMPT_DEFINITIONS[name];
    const activeVersion = state?.activeVersion ?? 0;
    return {
      name,
      title: definition.title,
      description: definition.description,
      placeholders: definition.placeholders.map((placeholder) => ({ ...placeholder })),
      activeVersion,
      latestVersion: state?.latestVersion ?? 0,
      isCustom: activeVersion > 0,
      updatedAt: activeVersion > 0 ? (activeAt?.toISOString() ?? null) : null,
    };
  }

  async function detailOf(shopId: string, name: PromptName): Promise<PromptDetail> {
    const state = await stateOf(shopId, name);
    const activeVersion = state?.activeVersion ?? 0;
    const docs = await PromptVersionModel.find({ shopId: shopObjectId(shopId), name })
      .select({ version: 1, chars: 1, note: 1, createdAt: 1, text: 1 })
      .sort({ version: -1 })
      .lean<Pick<PromptVersionDoc, 'version' | 'chars' | 'note' | 'createdAt' | 'text'>[]>();

    const globalText = getGlobalPrompt(name).text;
    const versions: PromptVersionInfo[] = docs.map((doc) => ({
      version: doc.version,
      source: 'store',
      createdAt: doc.createdAt.toISOString(),
      note: doc.note ?? null,
      chars: doc.chars,
      active: doc.version === activeVersion,
    }));
    versions.push({ version: 0, source: 'global', createdAt: null, note: null, chars: globalText.length, active: activeVersion === 0 });

    const active = docs.find((doc) => doc.version === activeVersion);
    // A state that points at a version that is gone behaves like the global default (resolve falls back the same way).
    const text = activeVersion === 0 || active === undefined ? globalText : active.text;
    return { ...summaryOf(name, state, active?.createdAt ?? null), text, globalText, versions };
  }

  return {
    async list(shopId) {
      const states = await PromptStateModel.find({ shopId: shopObjectId(shopId) }).lean<PromptStateDoc[]>();
      const byName = new Map(states.map((state) => [state.name, state]));
      const activeCustom = states.filter((state) => state.activeVersion > 0);
      const docs =
        activeCustom.length === 0
          ? []
          : await PromptVersionModel.find({
              shopId: shopObjectId(shopId),
              $or: activeCustom.map((state) => ({ name: state.name, version: state.activeVersion })),
            })
              .select({ name: 1, version: 1, createdAt: 1 })
              .lean<Pick<PromptVersionDoc, 'name' | 'version' | 'createdAt'>[]>();
      const createdAt = new Map(docs.map((doc) => [`${doc.name}:${doc.version}`, doc.createdAt]));
      return {
        items: PROMPT_NAMES.map((name) => {
          const state = byName.get(name) ?? null;
          return summaryOf(name, state, state === null ? null : (createdAt.get(`${name}:${state.activeVersion}`) ?? null));
        }),
      };
    },

    get: detailOf,

    async getVersion(shopId, name, version) {
      const text = await textOf(shopId, name, version);
      if (text === null) throw AppError.notFound('That version does not exist');
      const state = await stateOf(shopId, name);
      const active = (state?.activeVersion ?? 0) === version;
      if (version === 0) {
        return { version: 0, source: 'global', createdAt: null, note: null, chars: text.length, active, text };
      }
      const doc = await versionDoc(shopId, name, version);
      if (doc === null) throw AppError.notFound('That version does not exist');
      return { version, source: 'store', createdAt: doc.createdAt.toISOString(), note: doc.note ?? null, chars: doc.chars, active, text };
    },

    async save(actor: PromptActor, name, input) {
      const checked = validatePromptText(name, input.text);
      if (!checked.ok) {
        throw AppError.validation(checked.errors[0] ?? 'The prompt is not valid.', { errors: checked.errors });
      }

      const state = await stateOf(actor.shopId, name);
      const activeText = (await textOf(actor.shopId, name, state?.activeVersion ?? 0)) ?? getGlobalPrompt(name).text;
      // Saving what is already active would only add a version that looks exactly like the one before it.
      if (checked.text === activeText) return detailOf(actor.shopId, name);

      if ((state?.latestVersion ?? 0) >= PROMPT_MAX_VERSIONS) {
        throw AppError.shopLimit(
          `A prompt can have at most ${PROMPT_MAX_VERSIONS} versions. Go back to an earlier version or reset to the global default.`,
        );
      }

      const at = now();
      // $inc reserves the number atomically, so two saves at once get two different versions.
      const reserved = await PromptStateModel.findOneAndUpdate(
        { shopId: shopObjectId(actor.shopId), name },
        { $inc: { latestVersion: 1 }, $set: { updatedAt: at }, $setOnInsert: { activeVersion: 0 } },
        { upsert: true, returnDocument: 'after' },
      ).lean<PromptStateDoc>();
      if (reserved === null) throw AppError.internal('Could not reserve a prompt version');

      const version = reserved.latestVersion;
      try {
        await PromptVersionModel.create({
          shopId: shopObjectId(actor.shopId),
          name,
          version,
          text: checked.text,
          chars: checked.text.length,
          hash: hashText(checked.text),
          ...(input.note === undefined || input.note.trim() === '' ? {} : { note: input.note.trim() }),
          createdByUserId: new Types.ObjectId(actor.userId),
          createdAt: at,
        });
      } catch (err) {
        if (isDuplicateKey(err)) throw AppError.internal('Could not save the prompt version', err);
        throw err;
      }
      await PromptStateModel.updateOne({ shopId: shopObjectId(actor.shopId), name }, { $set: { activeVersion: version, updatedAt: at } });
      logger.info({ shopId: actor.shopId, prompt: name, version }, 'prompt version saved');
      return detailOf(actor.shopId, name);
    },

    async activate(actor: PromptActor, name, version) {
      if (version > 0 && (await versionDoc(actor.shopId, name, version)) === null) {
        throw AppError.notFound('That version does not exist');
      }
      if (version === 0 && (await stateOf(actor.shopId, name)) === null) return detailOf(actor.shopId, name);
      await PromptStateModel.updateOne(
        { shopId: shopObjectId(actor.shopId), name },
        { $set: { activeVersion: version, updatedAt: now() } },
      );
      logger.info({ shopId: actor.shopId, prompt: name, version }, 'prompt version activated');
      return detailOf(actor.shopId, name);
    },

    async resolve(shopId, name, version) {
      if (version === 0) return globalResolved(name);
      const key = `${shopId}:${name}:${version}`;
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const doc = await versionDoc(shopId, name, version);
      if (doc === null) {
        // Cannot happen through the API (versions are never deleted); the global default keeps the job running.
        logger.error({ shopId, prompt: name, version }, 'prompt version not found, using the global default');
        return globalResolved(name);
      }
      const resolved: ResolvedPrompt = { name, text: doc.text, hash: doc.hash, version, source: 'store' };
      remember(key, resolved);
      return resolved;
    },

    async activeRefs(shopId) {
      const states = await PromptStateModel.find({ shopId: shopObjectId(shopId) }).lean<PromptStateDoc[]>();
      const active = (name: PromptName): number => states.find((state) => state.name === name)?.activeVersion ?? 0;
      const refs: PromptRefs = { planner: active('planner.system'), image: active('image.user'), video: active('video.user') };
      return refs;
    },

    async purgeShop(shopId) {
      const shop = shopObjectId(shopId);
      await Promise.all([PromptVersionModel.deleteMany({ shopId: shop }), PromptStateModel.deleteMany({ shopId: shop })]);
      for (const key of cache.keys()) if (key.startsWith(`${shopId}:`)) cache.delete(key);
    },
  };
}
