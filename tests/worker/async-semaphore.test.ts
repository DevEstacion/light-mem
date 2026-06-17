
import { describe, it, expect } from 'vitest';
import { AsyncSemaphore } from '../../src/services/worker/AsyncSemaphore.js';

describe('AsyncSemaphore', () => {
  it('allows up to capacity concurrent acquires without blocking', async () => {
    const sem = new AsyncSemaphore(2);
    // Both acquires should resolve immediately
    await expect(sem.acquire()).resolves.toBeUndefined();
    await expect(sem.acquire()).resolves.toBeUndefined();
    sem.release();
    sem.release();
  });

  it('blocks the third acquire when capacity is 2', async () => {
    const sem = new AsyncSemaphore(2);
    await sem.acquire();
    await sem.acquire();

    let resolved = false;
    const p = sem.acquire().then(() => { resolved = true; });

    // Give microtasks a chance to settle — it should still be blocked
    await Promise.resolve();
    expect(resolved).toBe(false);

    sem.release();
    await p;
    expect(resolved).toBe(true);
    sem.release(); // clean up
  });

  it('unblocks waiters in FIFO order', async () => {
    const sem = new AsyncSemaphore(1);
    await sem.acquire(); // hold the slot

    const order: number[] = [];
    const a = sem.acquire().then(() => { order.push(1); });
    const b = sem.acquire().then(() => { order.push(2); });
    const c = sem.acquire().then(() => { order.push(3); });

    // Release three times to drain all waiters
    sem.release(); // unblocks waiter 1
    await a;
    sem.release(); // unblocks waiter 2
    await b;
    sem.release(); // unblocks waiter 3
    await c;

    expect(order).toEqual([1, 2, 3]);
    sem.release(); // release the slot acquired by c
  });

  it('rejects a queued waiter when the signal is aborted while waiting', async () => {
    const sem = new AsyncSemaphore(1);
    await sem.acquire(); // hold the only slot

    const controller = new AbortController();
    const waiter = sem.acquire(controller.signal);

    // Abort while waiting
    controller.abort();

    await expect(waiter).rejects.toThrow(/abort/i);

    // Release the held slot — should not throw even though waiter was rejected
    sem.release();
  });

  it('rejects immediately when passed an already-aborted signal', async () => {
    const sem = new AsyncSemaphore(2);
    const controller = new AbortController();
    controller.abort();

    await expect(sem.acquire(controller.signal)).rejects.toThrow(/abort/i);
  });
});
