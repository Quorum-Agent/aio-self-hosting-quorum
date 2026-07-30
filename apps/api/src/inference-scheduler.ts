import { ModelExecutionError } from "@quorum/core";

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

function abortError(): Error {
  return new ModelExecutionError(
    "The request was cancelled while waiting for local inference.",
    "cancelled",
  );
}

export class InferenceScheduler {
  readonly #concurrency: number;
  readonly #maximumQueue: number;
  readonly #queueWaitMs: number;
  readonly #queue: Waiter[] = [];
  #active = 0;

  constructor(concurrency = 1, maximumQueue = 8, queueWaitMs = 30_000) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error("Inference scheduler concurrency must be a positive integer.");
    }
    if (!Number.isInteger(maximumQueue) || maximumQueue < 0) {
      throw new Error("Inference scheduler queue limit must be a non-negative integer.");
    }
    if (!Number.isFinite(queueWaitMs) || queueWaitMs <= 0) {
      throw new Error("Inference scheduler queue wait must be positive.");
    }
    this.#concurrency = concurrency;
    this.#maximumQueue = maximumQueue;
    this.#queueWaitMs = queueWaitMs;
  }

  get active(): number {
    return this.#active;
  }

  get queued(): number {
    return this.#queue.length;
  }

  acquire(
    signal?: AbortSignal,
    maximumWaitMs?: number,
  ): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError());
    const enforcedWaitMs = maximumWaitMs ?? this.#queueWaitMs;
    if (!Number.isFinite(enforcedWaitMs) || enforcedWaitMs <= 0) {
      return Promise.reject(
        new ModelExecutionError(
          "Local inference queue wait budget is invalid.",
          "request",
        ),
      );
    }
    if (this.#active < this.#concurrency) {
      this.#active += 1;
      return Promise.resolve(this.#releaseOnce());
    }
    if (this.#queue.length >= this.#maximumQueue) {
      return Promise.reject(
        new ModelExecutionError(
          `Local inference queue is full (${this.#maximumQueue} waiting).`,
          "request",
        ),
      );
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        ...(signal ? { signal } : {}),
      };
      if (signal) {
        waiter.abort = () => {
          const index = this.#queue.indexOf(waiter);
          if (index >= 0) this.#queue.splice(index, 1);
          if (waiter.timer) clearTimeout(waiter.timer);
          reject(abortError());
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      waiter.timer = setTimeout(() => {
        const index = this.#queue.indexOf(waiter);
        if (index >= 0) this.#queue.splice(index, 1);
        if (waiter.signal && waiter.abort) {
          waiter.signal.removeEventListener("abort", waiter.abort);
        }
        reject(
          new ModelExecutionError(
            `Local inference queue wait exceeded ${enforcedWaitMs}ms.`,
            "request",
          ),
        );
      }, enforcedWaitMs);
      this.#queue.push(waiter);
    });
  }

  #releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      this.#drain();
    };
  }

  #drain(): void {
    while (this.#active < this.#concurrency) {
      const waiter = this.#queue.shift();
      if (!waiter) return;
      if (waiter.signal?.aborted) {
        if (waiter.timer) clearTimeout(waiter.timer);
        if (waiter.abort) {
          waiter.signal.removeEventListener("abort", waiter.abort);
        }
        waiter.reject(abortError());
        continue;
      }
      if (waiter.signal && waiter.abort) {
        waiter.signal.removeEventListener("abort", waiter.abort);
      }
      if (waiter.timer) clearTimeout(waiter.timer);
      this.#active += 1;
      waiter.resolve(this.#releaseOnce());
    }
  }
}
