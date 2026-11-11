import { afterEach, describe, expect, it, vi } from 'vitest';
import { startObserverLoop } from './observer.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('observer loop', () => {
  it('waits for a slow reconciliation run before scheduling the next one', async () => {
    vi.useFakeTimers();
    let resolveRun: (() => void) | undefined;
    let active = 0;
    let maxActive = 0;
    const run = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => { resolveRun = resolve; });
      active -= 1;
      return 'done';
    });
    const observer = startObserverLoop({
      intervalMs: 7_000,
      run,
      onSuccess: () => undefined,
      onError: () => undefined,
    });

    await vi.advanceTimersByTimeAsync(21_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(maxActive).toBe(1);

    resolveRun?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(7_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);

    resolveRun?.();
    await observer.stop();
  });
});
