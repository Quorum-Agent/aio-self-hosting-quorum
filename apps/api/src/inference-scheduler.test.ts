import { afterEach, describe, expect, it, vi } from "vitest";

import { InferenceScheduler } from "./inference-scheduler.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("InferenceScheduler", () => {
  it("serializes local inference leases", async () => {
    const scheduler = new InferenceScheduler();
    const releaseFirst = await scheduler.acquire();
    let secondAcquired = false;
    const second = scheduler.acquire().then((release) => {
      secondAcquired = true;
      return release;
    });

    await Promise.resolve();
    expect(secondAcquired).toBe(false);
    expect(scheduler).toMatchObject({ active: 1, queued: 1 });

    releaseFirst();
    const releaseSecond = await second;
    expect(secondAcquired).toBe(true);
    expect(scheduler).toMatchObject({ active: 1, queued: 0 });
    releaseSecond();
    expect(scheduler.active).toBe(0);
  });

  it("removes a cancelled request from the queue", async () => {
    const scheduler = new InferenceScheduler();
    const release = await scheduler.acquire();
    const controller = new AbortController();
    const queued = scheduler.acquire(controller.signal);

    controller.abort();
    await expect(queued).rejects.toThrow("cancelled");
    expect(scheduler.queued).toBe(0);
    release();
  });

  it("bounds both queue capacity and queue wait time", async () => {
    vi.useFakeTimers();
    const scheduler = new InferenceScheduler(1, 1, 10);
    const release = await scheduler.acquire();
    const queuedExpectation = expect(scheduler.acquire()).rejects.toThrow(
      "queue wait exceeded 10ms",
    );

    await expect(scheduler.acquire()).rejects.toThrow("queue is full");
    await vi.advanceTimersByTimeAsync(11);
    await queuedExpectation;
    expect(scheduler.queued).toBe(0);
    release();
  });
});
