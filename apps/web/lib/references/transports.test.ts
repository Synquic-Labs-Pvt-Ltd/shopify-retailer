import type { UploadTarget } from '@rs/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDirectXhrTransport, UPLOAD_TIMEOUT_MS } from './directTransport';
import { createMockTransport } from './mockTransport';
import { makeFile } from './testkit';
import type { UploadTransport } from './transport';
import { createAutoTransport, createRoutingTransport, proxyTransport } from './transports';
import {
  UploadAbortedError,
  UploadBlockedError,
  UploadError,
  UploadNetworkError,
  UploadNotImplementedError,
} from './uploadErrors';
import type { XhrHandle, XhrOutcome } from './xhr';

const TARGET: UploadTarget = {
  clientId: 'a',
  mediaId: 'm1',
  url: 'https://staged.example/upload',
  method: 'POST',
  parameters: [
    { name: 'key', value: 'tmp/1/a.jpg' },
    { name: 'Content-Type', value: 'image/jpeg' },
    { name: 'success_action_status', value: '201' },
  ],
};

class FakeXhr implements XhrHandle {
  method = '';
  url = '';
  timeoutMs = 0;
  body: FormData | null = null;
  aborts = 0;
  httpStatus = 0;
  private progress: (loaded: number, total: number) => void = () => undefined;
  private settled: (outcome: XhrOutcome) => void = () => undefined;

  open(method: string, url: string, timeoutMs: number): void {
    this.method = method;
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
  send(body: FormData): void {
    this.body = body;
  }
  abort(): void {
    this.aborts += 1;
    this.settled('abort');
  }
  status(): number {
    return this.httpStatus;
  }
  onUploadProgress(listener: (loaded: number, total: number) => void): void {
    this.progress = listener;
  }
  onSettled(listener: (outcome: XhrOutcome) => void): void {
    this.settled = listener;
  }
  sent(loaded: number, total: number): void {
    this.progress(loaded, total);
  }
  finish(outcome: XhrOutcome, status = 0): void {
    this.httpStatus = status;
    this.settled(outcome);
  }
}

function direct() {
  const created: FakeXhr[] = [];
  const transport = createDirectXhrTransport(() => {
    const xhr = new FakeXhr();
    created.push(xhr);
    return xhr;
  });
  return { transport, created };
}

const file = makeFile('a.jpg', 'image/jpeg', 100);

describe('direct XHR transport', () => {
  it('posts every parameter first and the file last, to the target url', async () => {
    const { transport, created } = direct();
    const done = transport.upload(TARGET, file, () => undefined, new AbortController().signal);
    const xhr = created[0] as FakeXhr;
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe(TARGET.url);
    expect(xhr.timeoutMs).toBe(UPLOAD_TIMEOUT_MS);
    expect(UPLOAD_TIMEOUT_MS).toBe(600_000);
    const entries = [...(xhr.body as FormData).entries()];
    expect(entries.map(([name]) => name)).toEqual(['key', 'Content-Type', 'success_action_status', 'file']);
    expect(entries[0]?.[1]).toBe('tmp/1/a.jpg');
    const sentFile = entries[3]?.[1] as File;
    expect(sentFile.name).toBe('a.jpg');
    expect(sentFile.size).toBe(100);
    xhr.finish('load', 201);
    await expect(done).resolves.toBeUndefined();
  });

  it('reports upload progress as a fraction', async () => {
    const { transport, created } = direct();
    const seen: number[] = [];
    const done = transport.upload(TARGET, file, (fraction) => seen.push(fraction), new AbortController().signal);
    const xhr = created[0] as FakeXhr;
    xhr.sent(25, 100);
    xhr.sent(0, 0);
    xhr.sent(100, 100);
    xhr.sent(120, 100);
    xhr.finish('load', 200);
    await done;
    expect(seen).toEqual([0.25, 1, 1]);
  });

  it('turns a non-2xx answer into a rejected upload', async () => {
    const { transport, created } = direct();
    const done = transport.upload(TARGET, file, () => undefined, new AbortController().signal);
    (created[0] as FakeXhr).finish('load', 403);
    await expect(done).rejects.toMatchObject({ name: 'UploadError', message: 'The upload was rejected (HTTP 403).' });
  });

  it('says whether bytes were sent before a network failure', async () => {
    for (const progressed of [false, true]) {
      const { transport, created } = direct();
      const done = transport.upload(TARGET, file, () => undefined, new AbortController().signal);
      if (progressed) (created[0] as FakeXhr).sent(10, 100);
      (created[0] as FakeXhr).finish('error');
      const error = await done.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UploadNetworkError);
      expect((error as UploadNetworkError).progressed).toBe(progressed);
    }
  });

  it('does not count an initial 0 byte progress event as progress', async () => {
    const { transport, created } = direct();
    const done = transport.upload(TARGET, file, () => undefined, new AbortController().signal);
    (created[0] as FakeXhr).sent(0, 100);
    (created[0] as FakeXhr).finish('error');
    expect(((await done.catch((caught: unknown) => caught)) as UploadNetworkError).progressed).toBe(false);
  });

  it('maps a timeout', async () => {
    const { transport, created } = direct();
    const done = transport.upload(TARGET, file, () => undefined, new AbortController().signal);
    (created[0] as FakeXhr).finish('timeout');
    await expect(done).rejects.toMatchObject({ message: 'The upload timed out.' });
  });

  it('aborts the request when the signal fires', async () => {
    const { transport, created } = direct();
    const controller = new AbortController();
    const done = transport.upload(TARGET, file, () => undefined, controller.signal);
    controller.abort();
    expect((created[0] as FakeXhr).aborts).toBe(1);
    await expect(done).rejects.toBeInstanceOf(UploadAbortedError);
  });

  it('does not start when the signal is already aborted', async () => {
    const { transport, created } = direct();
    const controller = new AbortController();
    controller.abort();
    await expect(transport.upload(TARGET, file, () => undefined, controller.signal)).rejects.toBeInstanceOf(
      UploadAbortedError,
    );
    expect(created).toHaveLength(0);
  });

  it('stops listening to the signal once the request has finished', async () => {
    const { transport, created } = direct();
    const controller = new AbortController();
    const done = transport.upload(TARGET, file, () => undefined, controller.signal);
    (created[0] as FakeXhr).finish('load', 201);
    await done;
    controller.abort();
    expect((created[0] as FakeXhr).aborts).toBe(0);
  });
});

function failing(error: Error): UploadTransport & { calls: number } {
  const transport = {
    calls: 0,
    upload: () => {
      transport.calls += 1;
      return Promise.reject(error);
    },
  };
  return transport;
}

describe('auto transport', () => {
  const signal = new AbortController().signal;

  it('passes a successful upload through', async () => {
    const ok: UploadTransport = { upload: () => Promise.resolve() };
    await expect(createAutoTransport(ok).upload(TARGET, file, () => undefined, signal)).resolves.toBeUndefined();
  });

  it('reports a request that failed before any byte was sent as blocked', async () => {
    const auto = createAutoTransport(failing(new UploadNetworkError(false)));
    await expect(auto.upload(TARGET, file, () => undefined, signal)).rejects.toBeInstanceOf(UploadBlockedError);
  });

  it('passes a failure after progress and other errors through', async () => {
    const afterProgress = new UploadNetworkError(true);
    await expect(
      createAutoTransport(failing(afterProgress)).upload(TARGET, file, () => undefined, signal),
    ).rejects.toBe(afterProgress);
    const rejected = new UploadError('The upload was rejected (HTTP 403).');
    await expect(createAutoTransport(failing(rejected)).upload(TARGET, file, () => undefined, signal)).rejects.toBe(
      rejected,
    );
    const aborted = new UploadAbortedError();
    await expect(createAutoTransport(failing(aborted)).upload(TARGET, file, () => undefined, signal)).rejects.toBe(
      aborted,
    );
  });

  it('uses the fallback for a blocked request when there is one', async () => {
    const fallback = vi.fn<UploadTransport['upload']>(() => Promise.resolve());
    const auto = createAutoTransport(failing(new UploadNetworkError(false)), { upload: fallback });
    await expect(auto.upload(TARGET, file, () => undefined, signal)).resolves.toBeUndefined();
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('does not use the fallback after progress', async () => {
    const fallback = vi.fn<UploadTransport['upload']>(() => Promise.resolve());
    const auto = createAutoTransport(failing(new UploadNetworkError(true)), { upload: fallback });
    await expect(auto.upload(TARGET, file, () => undefined, signal)).rejects.toBeInstanceOf(UploadNetworkError);
    expect(fallback).not.toHaveBeenCalled();
  });
});

describe('proxy transport', () => {
  it('is a stub that fails with a clear not implemented error', async () => {
    const error = await proxyTransport
      .upload(TARGET, file, () => undefined, new AbortController().signal)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UploadNotImplementedError);
    expect((error as Error).message).toBe('Uploading through the app server is not available yet.');
  });
});

describe('routing transport', () => {
  it('sends mock targets to the mock and everything else to the real transport', async () => {
    const mock = vi.fn<UploadTransport['upload']>(() => Promise.resolve());
    const real = vi.fn<UploadTransport['upload']>(() => Promise.resolve());
    const routing = createRoutingTransport({ upload: mock }, { upload: real });
    const signal = new AbortController().signal;
    await routing.upload({ ...TARGET, url: 'mock://staged-upload' }, file, () => undefined, signal);
    await routing.upload(TARGET, file, () => undefined, signal);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(real).toHaveBeenCalledTimes(1);
  });
});

describe('mock transport', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const mockTarget: UploadTarget = { ...TARGET, url: 'mock://staged-upload', parameters: [] };

  it('simulates about 1.5 seconds of progress and succeeds', async () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    const signal = new AbortController().signal;
    const done = createMockTransport().upload(mockTarget, file, (fraction) => seen.push(fraction), signal);
    await vi.advanceTimersByTimeAsync(1499);
    expect(seen).toHaveLength(11);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toBeUndefined();
    expect(seen).toHaveLength(12);
    expect(seen[11]).toBe(1);
  });

  it('stops partway with an error for a fail=1 target', async () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    const done = createMockTransport().upload(
      { ...mockTarget, url: 'mock://staged-upload?fail=1' },
      file,
      (fraction) => seen.push(fraction),
      new AbortController().signal,
    );
    const assertion = expect(done).rejects.toMatchObject({ message: 'The upload failed (simulated in mock mode).' });
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(seen).toHaveLength(8);
    expect(seen[7]).toBeLessThan(1);
  });

  it('can be aborted and stops reporting', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const seen: number[] = [];
    const done = createMockTransport().upload(mockTarget, file, (fraction) => seen.push(fraction), controller.signal);
    const assertion = expect(done).rejects.toBeInstanceOf(UploadAbortedError);
    await vi.advanceTimersByTimeAsync(300);
    controller.abort();
    await assertion;
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen).toHaveLength(2);
  });

  it('rejects at once when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createMockTransport().upload(mockTarget, file, () => undefined, controller.signal),
    ).rejects.toBeInstanceOf(UploadAbortedError);
  });
});
