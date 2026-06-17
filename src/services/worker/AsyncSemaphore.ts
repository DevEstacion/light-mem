
/**
 * Lightweight async counting semaphore — FIFO waiter queue.
 *
 * Usage:
 *   const sem = new AsyncSemaphore(2);
 *   await sem.acquire(signal); // blocks until a slot is free
 *   try { ... } finally { sem.release(); }
 */
export class AsyncSemaphore {
  private count: number;
  private readonly waiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  constructor(private readonly capacity: number) {
    this.count = capacity;
  }

  /**
   * Acquire one slot. Rejects if `signal` is already aborted or is aborted
   * while waiting. Resolves immediately when a slot is available.
   */
  acquire(signal?: AbortSignal): Promise<void> {
    // Fast-path: already aborted.
    if (signal?.aborted) {
      return Promise.reject(new Error('Acquire aborted: signal already aborted'));
    }

    // Slot available — take it immediately.
    if (this.count > 0) {
      this.count--;
      return Promise.resolve();
    }

    // No slot available — queue a waiter.
    return new Promise<void>((resolve, reject) => {
      // `cleanup` removes the abort listener (if any) so it doesn't leak onto
      // the long-lived session signal when the waiter resolves normally via
      // release(). Without this, every queued-then-unblocked acquire would
      // accumulate a dead listener for the session's lifetime.
      const waiter = {
        resolve: () => { cleanup(); resolve(); },
        reject: (err: Error) => { cleanup(); reject(err); },
      };
      this.waiters.push(waiter);

      let cleanup = () => {};
      if (signal) {
        const onAbort = () => {
          const idx = this.waiters.indexOf(waiter);
          if (idx !== -1) this.waiters.splice(idx, 1);
          waiter.reject(new Error('Acquire aborted: signal aborted while waiting'));
        };
        signal.addEventListener('abort', onAbort);
        cleanup = () => signal.removeEventListener('abort', onAbort);
      }
    });
  }

  /**
   * Release one slot. Unblocks the oldest queued waiter (FIFO) if any.
   */
  release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the slot directly to the next waiter without incrementing count.
      next.resolve();
    } else {
      this.count++;
    }
  }
}
