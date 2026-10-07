import { decodeJwt } from 'jose';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authSessionResponseSchema,
  batchListResponseSchema,
  batchSummarySchema,
  healthResponseSchema,
  mediaListResponseSchema,
  meResponseSchema,
  productDetailSchema,
  productListResponseSchema,
  type BatchDetail,
  type MediaObject,
  type ProductListItem,
} from '@rs/shared';
import { FAKE_JPEG, FAKE_MP4 } from '../../src/modules/ai/fake-media';
import { LoginCodeModel, SessionModel, UserModel } from '../../src/modules/auth/models';
import { BatchItemModel, BatchModel } from '../../src/modules/batches/models';
import { MediaAssetModel } from '../../src/modules/media/models';
import { JobModel } from '../../src/modules/queue/models';
import { ShopModel } from '../../src/modules/shops/model';
import { apiClient, browserFlow, createBatch, defined, errorOf, exchangeRequest, getBatch, uploadReferences, waitMediaSettled, type ApiClient, type UploadSpec } from './support/client';
import { MONGO_START_TIMEOUT_MS, startE2e, type E2e } from './support/harness';

const SHOP = 'demo-store.myshopify.com';
const SCOPES = ['read_files', 'read_products', 'write_files'];

let e2e: E2e;
let client: ApiClient;
let products: ProductListItem[] = [];
let references: { commonImage: MediaObject; commonVideo: MediaObject; ownImage: MediaObject };
let batchId = '';
let detail: BatchDetail;

beforeAll(async () => {
  e2e = await startE2e({ dbName: 'rs_e2e_happy' });
  e2e.stub.addShop(SHOP);
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await e2e.stop();
});

const stub = () => e2e.stub.state;
const without = (url: string): string => url.split('?')[0] ?? url;

describe('install and login (HTTP only)', () => {
  it('runs the offline phase, the online phase and the code exchange', async () => {
    const flow = await browserFlow(e2e, SHOP);
    const [start, afterOffline, deepLink] = flow.locations.map((location) => new URL(location));
    expect(flow.locations).toHaveLength(3);

    expect(start?.origin).toBe(`https://${SHOP}`);
    expect(start?.pathname).toBe('/admin/oauth/authorize');
    expect(start?.searchParams.get('client_id')).toBe('e2e-api-key');
    expect(start?.searchParams.get('scope')).toBe('read_products,read_files,write_files');
    expect(start?.searchParams.get('redirect_uri')).toBe('https://studio.example.com/auth/shopify/callback');
    expect(start?.searchParams.getAll('grant_options[]')).toEqual([]);

    expect(afterOffline?.searchParams.getAll('grant_options[]')).toEqual(['per-user']);
    expect(afterOffline?.searchParams.get('state')).not.toBe(start?.searchParams.get('state'));

    expect(deepLink?.protocol).toBe('retailerstudio:');
    expect(deepLink?.host).toBe('auth');

    const tokenCalls = stub().calls.filter((call) => call.kind === 'token');
    expect(tokenCalls.map((call) => ({ grant: call.grant, expiring: call.expiring, status: call.status }))).toEqual([
      { grant: 'authorization_code', expiring: true, status: 200 },
      { grant: 'authorization_code', expiring: false, status: 200 },
    ]);

    const shop = await ShopModel.findOne({ shopDomain: SHOP }).lean();
    const info = e2e.stub.shop(SHOP).info;
    expect(shop).toMatchObject({ status: 'active', shopGid: info.id, name: info.name, email: info.email, currencyCode: 'INR', ianaTimezone: 'Asia/Kolkata' });
    expect([...(shop?.scopes ?? [])].sort()).toEqual(SCOPES);
    // Tokens are stored sealed (iv:tag:cipher), never in clear.
    expect(JSON.stringify(shop)).not.toMatch(/shp(at|rt)_/);
    expect(shop?.offlineToken?.accessTokenEnc?.split(':')).toHaveLength(3);
    expect(shop?.offlineToken?.refreshTokenEnc?.split(':')).toHaveLength(3);
    const accessLife = (shop?.offlineToken?.accessTokenExpiresAt?.getTime() ?? 0) - Date.now();
    expect(accessLife).toBeGreaterThan(3_500_000);
    expect(accessLife).toBeLessThanOrEqual(3_600_000);
    const refreshLife = (shop?.offlineToken?.refreshTokenExpiresAt?.getTime() ?? 0) - Date.now();
    expect(refreshLife).toBeGreaterThan(7_700_000 * 1000);

    // The login code is stored hashed and is bound to the PKCE challenge.
    const loginCode = await LoginCodeModel.findOne().lean();
    expect(loginCode?.codeHash).not.toBe(flow.code);
    expect(loginCode?.codeChallenge).toBe(flow.pkce.challenge);

    const res = await exchangeRequest(e2e, flow);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const session = authSessionResponseSchema.parse(res.body);
    expect(session.shop).toMatchObject({ domain: SHOP, name: info.name });
    expect(session.user).toMatchObject({ email: 'asha@example.com', firstName: 'Asha', lastName: 'Verma' });
    expect(session.shop.id).toBe(String(shop?._id));

    const claims = decodeJwt(session.accessToken);
    expect(claims).toMatchObject({ sub: session.user.id, shopId: session.shop.id, shopDomain: SHOP, typ: 'access' });
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(900);
    expect(new Date(session.accessTokenExpiresAt).getTime()).toBe((claims.exp ?? 0) * 1000);

    const stored = await SessionModel.findOne().lean();
    expect(stored?.refreshTokenHash).not.toBe(session.refreshToken);
    expect(stored).toMatchObject({ platform: 'android', deviceName: 'Pixel 8' });
    expect(await UserModel.countDocuments({ shopId: shop?._id })).toBe(1);

    // The login code is single use.
    expect((await exchangeRequest(e2e, flow)).status).toBe(401);
    client = apiClient(e2e, session);
  });

  it('serves the generation settings on GET /me', async () => {
    expect((await request(e2e.app).get('/api/v1/me')).status).toBe(401);
    const res = await client.get('/api/v1/me');
    expect(res.status).toBe(200);
    const me = meResponseSchema.parse(res.body);
    const config = e2e.config.get();
    expect(me.generation).toEqual({
      imagesPerProduct: 2,
      videosPerProduct: 1,
      references: config.references,
      maxProductsPerBatch: config.batch.maxProductsPerBatch,
    });
    expect(me.shop.domain).toBe(SHOP);
  });
});

describe('products', () => {
  it('pages through the catalog with cursors', async () => {
    const seen: ProductListItem[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const res: request.Response = await client.get(`/api/v1/products?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`);
      expect(res.status).toBe(200);
      const body = productListResponseSchema.parse(res.body);
      seen.push(...body.items);
      if (!body.pageInfo.hasNextPage) break;
      cursor = body.pageInfo.endCursor;
    }
    expect(seen.map((item) => item.title)).toEqual(e2e.stub.shop(SHOP).products.map((product) => product.title));
    expect(new Set(seen.map((item) => item.id)).size).toBe(5);
    expect(seen[0]).toMatchObject({ handle: 'ceramic-table-lamp', status: 'ACTIVE', vendor: 'Atelier Nord', productType: 'Lighting', mediaCount: 6, variantsCount: 1 });
    expect(seen[0]?.imageUrl).toContain('/products/ceramic-table-lamp-1.jpg');
    products = seen;
  });

  it('searches by title', async () => {
    const res = await client.get('/api/v1/products?q=lamp');
    expect(res.status).toBe(200);
    expect(productListResponseSchema.parse(res.body).items.map((item) => item.title)).toEqual(['Ceramic Table Lamp', 'Brass Desk Lamp']);
    const search = stub().calls.filter((call) => call.kind === 'graphql' && call.operation === 'ProductList').at(-1);
    expect(search?.kind === 'graphql' ? search.variables.query : null).toBe('title:*lamp*');
  });

  it('returns a product detail with plain text and resized image urls', async () => {
    const lamp = products[0];
    const res = await client.get(`/api/v1/products/${encodeURIComponent(lamp?.id ?? '')}`);
    expect(res.status).toBe(200);
    const detailBody = productDetailSchema.parse(res.body);
    expect(detailBody.descriptionText).toBe('Hand glazed lamp.\nLinen shade');
    expect(detailBody.imageUrls).toHaveLength(5);
    expect(detailBody.featuredImageUrl).toContain('width=1536');
    expect(detailBody.imageUrls.every((url) => url.includes('width=1536'))).toBe(true);
    expect((await client.get(`/api/v1/products/${encodeURIComponent('gid://shopify/Product/1')}`)).status).toBe(404);
  });
});

describe('reference uploads', () => {
  const image = (clientId: string, scope: UploadSpec['scope'], productGid?: string): UploadSpec => ({
    clientId,
    filename: `${clientId}.jpg`,
    mimeType: 'image/jpeg',
    bytes: FAKE_JPEG,
    scope,
    ...(productGid === undefined ? {} : { productGid }),
  });

  it('stages, uploads and completes a common image, a common video and a product image', async () => {
    const specs: UploadSpec[] = [
      image('common-image', 'common'),
      { clientId: 'common-video', filename: 'room.mp4', mimeType: 'video/mp4', bytes: FAKE_MP4, scope: 'common', durationSec: 12 },
      image('own-image', 'product', products[0]?.id),
    ];
    const completed = await uploadReferences(client, specs);
    expect(completed.map((item) => item.status)).toEqual(['processing', 'processing', 'processing']);

    const rows = await MediaAssetModel.find({ _id: { $in: completed.map((item) => item.id) } }).lean();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toMatchObject({ role: 'reference', alt: 'Retailer Studio reference', storageProvider: 'shopify' });
      expect(row.filename).toMatch(/^rs-ref-[0-9a-f]{8}\.(jpg|mp4)$/);
      expect(row.shopify?.fileGid).toMatch(/^gid:\/\/shopify\/(MediaImage|Video)\//);
    }

    // Lazy refresh asks Shopify at most once per asset every 3 seconds.
    const ids = completed.map((item) => item.id);
    const statusQueries = () => e2e.stub.graphqlOperations().filter((operation) => operation === 'FileStatus').length;
    const askedAt = Date.now();
    const first = await client.get(`/api/v1/media?ids=${ids.join(',')}`);
    const second = await client.get(`/api/v1/media?ids=${ids.join(',')}`);
    expect(mediaListResponseSchema.parse(first.body).items.map((item) => item.status)).toEqual(['processing', 'processing', 'processing']);
    expect(mediaListResponseSchema.parse(second.body).items).toHaveLength(3);
    // Two reads in the same moment cost one question to Shopify (skipped when the machine stalled for seconds).
    if (Date.now() - askedAt < 2_500) expect(statusQueries()).toBe(1);

    const ready = await waitMediaSettled(client, ids);
    expect(ready.map((item) => item.status)).toEqual(['ready', 'ready', 'ready']);
    const [commonImage, commonVideo, ownImage] = ready;
    if (commonImage === undefined || commonVideo === undefined || ownImage === undefined) throw new Error('missing references');
    expect(statusQueries()).toBeGreaterThanOrEqual(2);

    for (const item of [commonImage, ownImage]) {
      expect(item).toMatchObject({ role: 'reference', mediaType: 'image', width: 16, height: 16, durationSec: null });
      expect(item.url).toMatch(/^https:\/\/cdn\.shopify\.com\/s\/files\/1\/1\/files\/rs-ref-[0-9a-f]{8}\.jpg/);
      expect(item.previewUrl).toBe(item.url);
    }
    expect(commonImage.scope).toBe('common');
    expect(ownImage).toMatchObject({ scope: 'product', productGid: products[0]?.id });
    expect(commonVideo).toMatchObject({ mediaType: 'video', scope: 'common', durationSec: 12.5, width: 1080, height: 1920 });
    expect(commonVideo.url).toMatch(/\/videos\/c\/vp\/.+\/HD-1080p.*\.mp4$/);
    expect(commonVideo.previewUrl).toMatch(/preview\.jpg$/);

    // The staged targets received every parameter first and the bytes last.
    const uploads = stub().calls.filter((call) => call.kind === 'staged_upload');
    expect(uploads).toHaveLength(3);
    expect(uploads.map((call) => call.size).sort()).toEqual([FAKE_JPEG.byteLength, FAKE_JPEG.byteLength, FAKE_MP4.byteLength].sort());
    references = { commonImage, commonVideo, ownImage };
  });
});

describe('batch', () => {
  it('accepts three products with one own reference and two inheriting the common ones', async () => {
    const [first, second, third] = products;
    const res = await createBatch(client, {
      products: [
        { productGid: first?.id ?? '', referenceMediaIds: [references.ownImage.id] },
        { productGid: second?.id ?? '' },
        { productGid: third?.id ?? '' },
      ],
      commonReferenceMediaIds: [references.commonImage.id, references.commonVideo.id],
    });
    expect(res.status).toBe(201);
    const summary = batchSummarySchema.parse(res.body);
    batchId = summary.id;
    expect(summary).toMatchObject({
      status: 'queued',
      finishedAt: null,
      counts: { products: 3, jobsTotal: 12, jobsSucceeded: 0, jobsFailed: 0, jobsCancelled: 0, imagesReady: 0, videosReady: 0 },
      configSnapshot: { outputs: { imagesPerProduct: 2, videosPerProduct: 1 } },
    });
    expect(summary.coverImageUrl).toContain('/products/ceramic-table-lamp-1.jpg');
    expect(summary.coverImageUrl).toContain('width=1536');

    const items = await BatchItemModel.find({ batchId }).sort({ _id: 1 }).lean();
    expect(items.map((item) => item.referenceMode)).toEqual(['own_plus_common', 'common_only', 'common_only']);
    expect(items[0]?.effectiveReferenceMediaIds.map(String)).toEqual([references.ownImage.id, references.commonImage.id, references.commonVideo.id]);
    expect(items[1]?.effectiveReferenceMediaIds.map(String)).toEqual([references.commonImage.id, references.commonVideo.id]);

    const jobs = await JobModel.find({ batchId }).lean();
    expect(jobs).toHaveLength(12);
    const byType = (type: string) => jobs.filter((job) => job.type === type);
    expect(byType('plan').map((job) => [job.status, job.lane])).toEqual(Array(3).fill(['queued', 'fake:gemini-2.5-flash']));
    expect(byType('image').map((job) => [job.status, job.lane, job.dependsOn.length])).toEqual(Array(6).fill(['blocked', 'fake:gemini-2.5-flash-image', 1]));
    expect(byType('video').map((job) => [job.status, job.lane, job.dependsOn.length])).toEqual(Array(3).fill(['blocked', 'fake:veo-3.1-generate-001', 1]));

    const list = batchListResponseSchema.parse((await client.get('/api/v1/batches')).body);
    expect(list.items.map((item) => item.id)).toEqual([batchId]);
    expect(list.pageInfo.hasNextPage).toBe(false);
  });

  it('drives the queue until the batch is completed', async () => {
    const batch = await e2e.driveBatch(batchId);
    expect(batch.status).toBe('completed');
    await e2e.settle();
    detail = await getBatch(client, batchId);
  }, 90_000);

  it('reports every product with two images, one video and the right counts', async () => {
    expect(detail).toMatchObject({
      status: 'completed',
      delay: null,
      counts: { products: 3, jobsTotal: 12, jobsSucceeded: 12, jobsFailed: 0, jobsCancelled: 0, imagesReady: 6, videosReady: 3 },
    });
    expect(detail.finishedAt).not.toBeNull();
    expect(detail.items.map((item) => item.referenceMode)).toEqual(['own_plus_common', 'common_only', 'common_only']);

    const batchShort = batchId.slice(-6);
    for (const [index, item] of detail.items.entries()) {
      const product = e2e.stub.shop(SHOP).products[index];
      expect(item).toMatchObject({ productGid: products[index]?.id, title: product?.title, status: 'completed' });
      expect(item.imageUrl).toContain(`/products/${product?.handle}-1.jpg`);
      expect(item.jobs.map((job) => [job.type, job.outputIndex, job.status, job.errorCode])).toEqual([
        ['plan', null, 'succeeded', null],
        ['image', 0, 'succeeded', null],
        ['image', 1, 'succeeded', null],
        ['video', 0, 'succeeded', null],
      ]);

      expect(item.outputs.map((output) => output.mediaType)).toEqual(['image', 'image', 'video']);
      expect(item.outputs.map((output) => output.filename)).toEqual([
        `rs-${product?.handle}-${batchShort}-img1.jpg`,
        `rs-${product?.handle}-${batchShort}-img2.jpg`,
        `rs-${product?.handle}-${batchShort}-vid1.mp4`,
      ]);
      expect(item.outputs.map((output) => output.shotTitle)).toEqual(['Fake image shot 1', 'Fake image shot 2', 'Fake video shot 1']);
      for (const output of item.outputs) {
        expect(output).toMatchObject({ role: 'output', status: 'ready', productGid: products[index]?.id, scope: null });
        expect(output.url).toMatch(/^https:\/\/cdn\.shopify\.com\//);
        expect(output.previewUrl).not.toBeNull();
      }
      expect(item.outputs[0]).toMatchObject({ width: 16, height: 16 });
      expect(item.outputs[2]).toMatchObject({ durationSec: 12.5, width: 1080, height: 1920 });
    }

    // The same media are served by GET /media.
    const outputIds = detail.items.flatMap((item) => item.outputs.map((output) => output.id));
    const listed = mediaListResponseSchema.parse((await client.get(`/api/v1/media?ids=${outputIds.slice(0, 9).join(',')}`)).body);
    expect(listed.items.every((item) => item.status === 'ready')).toBe(true);
  });

  it('does not let an output be deleted', async () => {
    const output = defined(detail.items[0]?.outputs[0]);
    const res = await client.delete(`/api/v1/media/${output.id}`);
    expect(res.status).toBe(403);
    expect(errorOf(res).code).toBe('forbidden');
    expect((await MediaAssetModel.findById(output.id).lean())?.status).toBe('ready');
  });

  it('stored the planner plan, the audit trail and the output links', async () => {
    const items = await BatchItemModel.find({ batchId }).sort({ _id: 1 }).lean();
    const batch = await BatchModel.findById(batchId).lean();
    for (const item of items) {
      expect(item.planSource).toBe('planner');
      expect(item.creativePlan?.imageShots).toHaveLength(2);
      expect(item.creativePlan?.videoShots).toHaveLength(1);
      expect(item.outputMediaIds).toHaveLength(3);
      expect(item.counts).toMatchObject({ jobsTotal: 4, succeeded: 4, failed: 0, cancelled: 0 });
      expect(item.finishedAt).toBeInstanceOf(Date);
    }
    expect(batch?.startedAt).toBeInstanceOf(Date);
    expect(batch?.finishedAt).toBeInstanceOf(Date);

    const jobs = await JobModel.find({ batchId }).lean();
    expect(jobs.every((job) => job.status === 'succeeded' && job.attempts === 1 && job.deferrals === 0)).toBe(true);
    const versions = batch?.configSnapshot.promptVersions;
    for (const job of jobs) {
      const expected = job.type === 'plan' ? versions?.planner : job.type === 'image' ? versions?.image : versions?.video;
      expect(job.promptVersion).toBe(expected);
      expect(job.renderedPrompt).toBeTruthy();
      expect(job.renderedPrompt).not.toContain('{{');
      if (job.type !== 'plan') expect(String(job.output?.mediaAssetId)).toMatch(/^[a-f0-9]{24}$/);
    }
    expect(jobs.filter((job) => job.type === 'plan').every((job) => job.output?.providerResponseId?.startsWith('fake-plan-'))).toBe(true);
    const outputs = await MediaAssetModel.find({ batchId, role: 'output' }).lean();
    expect(outputs).toHaveLength(9);
    for (const output of outputs) {
      const item = items.find((candidate) => candidate._id.equals(output.batchItemId));
      expect(output.sourceJobId).toBeInstanceOf(Types.ObjectId);
      expect(output.alt).toBe(`${item?.productSnapshot.title}: ${output.shotTitle}`);
    }
  });

  it('fetched the references the way the spec describes', async () => {
    const fetched = (url: string): number => stub().calls.filter((call) => call.kind === 'cdn' && call.url.startsWith(without(url)) && call.status === 200).length;
    // plan + 2 image jobs of the first product use its own reference; every product uses the common image the same way.
    expect(fetched(references.ownImage.url ?? '')).toBe(3);
    expect(fetched(references.commonImage.url ?? '')).toBe(9);
    // Reference videos reach the planner by public url only.
    expect(fetched(references.commonVideo.url ?? '')).toBe(0);
    expect(stub().calls.filter((call) => call.kind === 'cdn' && call.status !== 200)).toEqual([]);
  });
});

describe('what Shopify saw', () => {
  it('received the staged uploads and files, and no product mutation', async () => {
    const operations = e2e.stub.graphqlOperations();
    const count = (name: string): number => operations.filter((operation) => operation === name).length;
    // One staged call for the three references, then one per output.
    expect(count('StagedUploadsCreate')).toBe(1 + 9);
    expect(count('FileCreate')).toBe(3 + 9);
    expect(count('FileDelete')).toBe(0);
    expect([...new Set(operations)].sort()).toEqual(
      ['FileCreate', 'FileStatus', 'ProductDetail', 'ProductList', 'ProductSnapshots', 'ShopInfo', 'StagedUploadsCreate'].sort(),
    );

    const shop = e2e.stub.shop(SHOP);
    expect(shop.files.size).toBe(12);
    const files = [...shop.files.values()];
    const outputs = files.filter((file) => !file.filename.startsWith('rs-ref-'));
    expect(outputs).toHaveLength(9);
    expect(outputs.filter((file) => file.mediaType === 'image').map((file) => file.filename)).toHaveLength(6);
    expect(outputs.filter((file) => file.mediaType === 'video').every((file) => file.filename.endsWith('.mp4'))).toBe(true);
    const titles = detail.items.map((item) => item.title);
    for (const file of outputs) expect(titles.some((title) => file.alt.startsWith(`${title}: Fake `))).toBe(true);
    expect(files.filter((file) => file.filename.startsWith('rs-ref-')).every((file) => file.alt === 'Retailer Studio reference')).toBe(true);

    // The bytes that reached Shopify are the ones the provider produced.
    const staged = [...shop.stagedByKey.values()];
    expect(staged).toHaveLength(12);
    expect(staged.every((target) => target.received !== null)).toBe(true);
    expect(staged.filter((target) => target.resource === 'VIDEO').every((target) => target.received?.bytes.byteLength === FAKE_MP4.byteLength)).toBe(true);
    expect(staged.filter((target) => target.resource === 'IMAGE').every((target) => target.received?.bytes[0] === 0xff && target.received.bytes[1] === 0xd8)).toBe(true);

    // Admin calls always used the offline token, never the discarded online one.
    const tokens = stub().calls.flatMap((call) => (call.kind === 'graphql' ? [call.token] : []));
    expect(tokens.every((token) => token !== undefined && shop.offlineTokens.has(token))).toBe(true);
    expect(tokens.some((token) => token !== undefined && shop.onlineTokens.has(token))).toBe(false);
    expect(stub().unexpected).toEqual([]);
  });

  it('logged no warning or error on the happy path', () => {
    // The orphan sweep may win a harmless race with the handler that releases the same dependents.
    expect(e2e.problems(['released blocked jobs whose dependencies were already terminal'])).toEqual([]);
  });

  it('reports a healthy worker and no paused lane', async () => {
    const res = await request(e2e.app).get('/health');
    expect(res.status).toBe(200);
    const health = healthResponseSchema.parse(res.body);
    expect(health).toMatchObject({ ok: true, db: 'connected', pausedLanes: [] });
    expect(health.worker.lastTickAt).not.toBeNull();
  });
});
