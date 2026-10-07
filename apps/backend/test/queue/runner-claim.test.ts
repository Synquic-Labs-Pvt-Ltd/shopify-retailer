import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JobModel } from '../../src/modules/queue/models';
import { MONGO_START_TIMEOUT_MS, startTestMongo, type TestMongo } from '../helpers/mongo';
import {
  createClock,
  createConfigHolder,
  createRig,
  createStubGovernor,
  deferred,
  handlerFor,
  insertJob,
  openLane,
  reloadJob,
  START,
  tickAndSettle,
  waitFor,
  type Deferred,
} from './kit';

let mongo: TestMongo;

beforeAll(async () => {
  mongo = await startTestMongo('rs_queue_claim');
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.clear();
});

const at = (offsetMs: number): Date => new Date(new Date(START).getTime() + offsetMs);

describe('claim', () => {
  it('claims by priority desc, then runAt asc, then createdAt asc, and skips jobs that are not due', async () => {
    const rig = createRig({ governor: createStubGovernor() });
    const order: string[] = [];
    rig.module.runner.registerHandler(
      handlerFor('image', async (job) => {
        order.push(job.id);
        return { kind: 'succeeded' };
      }),
    );
    const lane = 'test:img';
    const a = await insertJob({ lane, priority: 0, runAt: at(-5000), createdAt: at(-5000) });
    const b = await insertJob({ lane, priority: 0, runAt: at(-5000), createdAt: at(-6000) });
    const c = await insertJob({ lane, priority: 0, runAt: at(-9000), createdAt: at(-1000) });
    const d = await insertJob({ lane, priority: 10, runAt: at(-1000), createdAt: at(-1000) });
    const e = await insertJob({ lane, priority: 5, runAt: at(-8000), createdAt: at(-8000) });
    const future = await insertJob({ lane, priority: 99, runAt: at(1000) });

    await tickAndSettle(rig);

    expect(order).toEqual([d, e, c, b, a].map((doc) => doc._id.toHexString()));
    expect((await reloadJob(future._id)).status).toBe('queued');
  });

  it('dispatches without awaiting the handler and sets lease, attempts and startedAt atomically', async () => {
    const rig = createRig({ governor: createStubGovernor(), instanceId: 'worker-7' });
    const gate = deferred<void>();
    rig.module.runner.registerHandler(
      handlerFor('image', async () => {
        await gate.promise;
        return { kind: 'succeeded' };
      }),
    );
    const job = await insertJob({ lane: 'test:img' });

    await rig.module.runner.tickOnce();

    const running = await reloadJob(job._id);
    expect(running.status).toBe('running');
    expect(running.attempts).toBe(1);
    expect(running.lease?.owner).toBe('worker-7');
    expect(running.lease?.expiresAt?.toISOString()).toBe(at(180_000).toISOString());
    expect(running.startedAt?.toISOString()).toBe(START);

    gate.resolve();
    await rig.module.runner.idle();
    expect((await reloadJob(job._id)).status).toBe('succeeded');
  });

  it('gives the governor token back when the claim finds nothing', async () => {
    const governor = createStubGovernor();
    const rig = createRig({ governor });
    rig.module.runner.registerHandler(handlerFor('image', async () => ({ kind: 'succeeded' })));
    const job = await insertJob({ lane: 'test:img' });
    // The job disappears between the token and the claim.
    governor.onAcquire = async () => {
      await JobModel.updateOne({ _id: job._id }, { $set: { status: 'cancelled' } });
    };

    await tickAndSettle(rig);

    expect(governor.acquired).toEqual(['test:img']);
    expect(governor.released).toEqual(['test:img']);
  });

  it('stops a lane for the tick when the governor refuses, leaving its jobs queued', async () => {
    const governor = createStubGovernor();
    governor.deny.add('test:img');
    const rig = createRig({ governor });
    let calls = 0;
    rig.module.runner.registerHandler(
      handlerFor('image', async () => {
        calls += 1;
        return { kind: 'succeeded' };
      }),
    );
    await insertJob({ lane: 'test:img' });
    await insertJob({ lane: 'test:img' });

    await tickAndSettle(rig);

    expect(calls).toBe(0);
    expect(governor.acquired).toEqual(['test:img']);
    expect(await JobModel.countDocuments({ status: 'queued' })).toBe(2);
  });

  it('does not claim job types that have no registered handler', async () => {
    const governor = createStubGovernor();
    const rig = createRig({ governor });
    rig.module.runner.registerHandler(handlerFor('image', async () => ({ kind: 'succeeded' })));
    const video = await insertJob({ lane: 'test:vid', type: 'video' });

    await tickAndSettle(rig);

    expect(governor.acquired).toEqual([]);
    expect((await reloadJob(video._id)).status).toBe('queued');
  });

  it('rejects a second handler for the same type', () => {
    const rig = createRig({ governor: createStubGovernor() });
    rig.module.runner.registerHandler(handlerFor('image', async () => ({ kind: 'succeeded' })));
    expect(() => rig.module.runner.registerHandler(handlerFor('image', async () => ({ kind: 'succeeded' })))).toThrow(/already registered/);
  });

  it('keeps going with other lanes when one lane fails, and reports the tick as unhealthy', async () => {
    const governor = createStubGovernor();
    const rig = createRig({ governor });
    rig.module.runner.registerHandler(handlerFor('image', async () => ({ kind: 'succeeded' })));
    governor.onAcquire = async (lane) => {
      if (lane === 'test:a') throw new Error('mongo hiccup');
    };
    await insertJob({ lane: 'test:a' });
    const ok = await insertJob({ lane: 'test:b' });

    await tickAndSettle(rig);

    expect((await reloadJob(ok._id)).status).toBe('succeeded');
    expect(rig.module.runner.lastTickAt).toBeNull();
  });
});

describe('two runners racing', () => {
  it('never run the same job twice', async () => {
    const clock = createClock();
    const cfg = createConfigHolder({ 'test:img': openLane() });
    const a = createRig({ clock, cfg, governor: createStubGovernor(), instanceId: 'runner-a' });
    const b = createRig({ clock, cfg, governor: createStubGovernor(), instanceId: 'runner-b' });
    const runs = new Map<string, string[]>();
    const handlerOf = (owner: string) =>
      handlerFor('image', async (job) => {
        runs.set(job.id, [...(runs.get(job.id) ?? []), owner]);
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { kind: 'succeeded' };
      });
    a.module.runner.registerHandler(handlerOf('runner-a'));
    b.module.runner.registerHandler(handlerOf('runner-b'));
    for (let i = 0; i < 40; i += 1) await insertJob({ lane: 'test:img' });

    await Promise.all([a.module.runner.tickOnce(), b.module.runner.tickOnce()]);
    await Promise.all([a.module.runner.idle(), b.module.runner.idle()]);

    expect(runs.size).toBe(40);
    expect([...runs.values()].every((owners) => owners.length === 1)).toBe(true);
    const docs = await JobModel.find().lean();
    expect(docs.every((doc) => doc.status === 'succeeded' && doc.attempts === 1)).toBe(true);
  });
});

describe('with the real governor', () => {
  it('never runs more than maxConcurrent jobs of a lane at once', async () => {
    const rig = createRig({ lanes: { 'test:img': openLane({ maxConcurrent: 2 }) } });
    const gates: Deferred<void>[] = [];
    let active = 0;
    let peak = 0;
    let finished = 0;
    rig.module.runner.registerHandler(
      handlerFor('image', async () => {
        const gate = deferred<void>();
        gates.push(gate);
        active += 1;
        peak = Math.max(peak, active);
        await gate.promise;
        active -= 1;
        finished += 1;
        return { kind: 'succeeded' };
      }),
    );
    for (let i = 0; i < 5; i += 1) await insertJob({ lane: 'test:img' });

    await rig.module.runner.tickOnce();
    expect(gates).toHaveLength(2);
    await rig.module.runner.tickOnce();
    expect(gates).toHaveLength(2);

    gates[0]?.resolve();
    await waitFor(() => finished === 1);
    await rig.module.runner.tickOnce();
    expect(gates).toHaveLength(3);

    for (const gate of gates) gate.resolve();
    await rig.module.runner.idle();
    await rig.module.runner.tickOnce();
    for (const gate of gates) gate.resolve();
    await rig.module.runner.idle();
    await rig.module.runner.tickOnce();
    for (const gate of gates) gate.resolve();
    await rig.module.runner.idle();

    expect(peak).toBe(2);
    expect(await JobModel.countDocuments({ status: 'succeeded' })).toBe(5);
  });

  it('paces dispatch by the per-minute window', async () => {
    const rig = createRig({ lanes: { 'test:img': openLane({ rpm: 3 }) } });
    let calls = 0;
    rig.module.runner.registerHandler(
      handlerFor('image', async () => {
        calls += 1;
        return { kind: 'succeeded' };
      }),
    );
    for (let i = 0; i < 5; i += 1) await insertJob({ lane: 'test:img' });

    await tickAndSettle(rig);
    expect(calls).toBe(3);
    await tickAndSettle(rig);
    expect(calls).toBe(3);

    rig.clock.advance(60_000);
    await tickAndSettle(rig);
    expect(calls).toBe(5);
  });

  it('applies a lowered rpm on the next tick without a restart', async () => {
    const rig = createRig({ lanes: { 'test:img': openLane({ rpm: 100 }) } });
    let calls = 0;
    rig.module.runner.registerHandler(
      handlerFor('image', async () => {
        calls += 1;
        return { kind: 'succeeded' };
      }),
    );
    for (let i = 0; i < 12; i += 1) await insertJob({ lane: 'test:img' });

    rig.cfg.lanes['test:img'] = openLane({ rpm: 3 });
    await tickAndSettle(rig);
    expect(calls).toBe(3);

    rig.cfg.lanes['test:img'] = openLane({ rpm: 5 });
    await tickAndSettle(rig);
    expect(calls).toBe(5);

    rig.cfg.lanes['test:img'] = openLane({ rpm: 2 });
    await tickAndSettle(rig);
    expect(calls).toBe(5);

    rig.cfg.lanes['test:img'] = openLane({ rpm: 100 });
    await tickAndSettle(rig);
    expect(calls).toBe(12);
  });

  it('uses the fake:* wildcard lane', async () => {
    const rig = createRig();
    rig.cfg.lanes['fake:*'] = openLane({ rpm: 2 });
    let calls = 0;
    rig.module.runner.registerHandler(
      handlerFor('image', async () => {
        calls += 1;
        return { kind: 'succeeded' };
      }),
    );
    for (let i = 0; i < 4; i += 1) await insertJob({ lane: 'fake:gemini-2.5-flash-image' });
    await tickAndSettle(rig);
    expect(calls).toBe(2);
  });
});

describe('tick loop', () => {
  it('records lastTickAt, and a tick never overlaps with itself', async () => {
    const governor = createStubGovernor();
    let simultaneous = 0;
    let peak = 0;
    governor.onAcquire = async () => {
      simultaneous += 1;
      peak = Math.max(peak, simultaneous);
      await new Promise((resolve) => setTimeout(resolve, 25));
      simultaneous -= 1;
    };
    const rig = createRig({ governor });
    rig.cfg.queue = { ...rig.cfg.queue, tickMs: 1 };
    rig.module.runner.registerHandler(handlerFor('image', async () => ({ kind: 'succeeded' })));
    for (let i = 0; i < 6; i += 1) await insertJob({ lane: 'test:img' });

    expect(rig.module.runner.lastTickAt).toBeNull();
    rig.module.runner.start();
    await waitFor(async () => (await JobModel.countDocuments({ status: 'succeeded' })) === 6, 10_000);
    await rig.module.runner.stop();

    expect(peak).toBe(1);
    expect(rig.module.runner.lastTickAt?.toISOString()).toBe(START);
  });

  it('stop waits for in-flight handlers', async () => {
    const rig = createRig({ governor: createStubGovernor() });
    const gate = deferred<void>();
    let started = false;
    rig.module.runner.registerHandler(
      handlerFor('image', async () => {
        started = true;
        await gate.promise;
        return { kind: 'succeeded' };
      }),
    );
    const job = await insertJob({ lane: 'test:img' });
    rig.module.runner.start();
    await waitFor(() => started);

    let stopped = false;
    const stopping = rig.module.runner.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(false);

    gate.resolve();
    await stopping;
    expect((await reloadJob(job._id)).status).toBe('succeeded');
  });

  it('aborts handlers that outlive the grace period and requeues their jobs without spending the attempt', async () => {
    const rig = createRig({ governor: createStubGovernor(), shutdownGraceMs: 30 });
    let sawAbort = false;
    rig.module.runner.registerHandler(
      handlerFor(
        'image',
        (_job, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              sawAbort = true;
              reject(signal.reason);
            });
          }),
      ),
    );
    const job = await insertJob({ lane: 'test:img' });
    rig.module.runner.start();
    await waitFor(async () => (await reloadJob(job._id)).status === 'running');

    await rig.module.runner.stop();

    expect(sawAbort).toBe(true);
    const after = await reloadJob(job._id);
    expect(after).toMatchObject({ status: 'queued', attempts: 0 });
    expect(after.lease).toBeUndefined();
  });
});
