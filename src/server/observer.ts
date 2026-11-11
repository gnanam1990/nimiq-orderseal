export interface ObserverLoop<T> {
  stop: () => Promise<void>;
}

export function startObserverLoop<T>(options: {
  intervalMs: number;
  run: () => Promise<T>;
  onSuccess: (result: T) => void;
  onError: (error: unknown) => void;
}): ObserverLoop<T> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: Promise<void> | null = null;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      active = options.run()
        .then(options.onSuccess)
        .catch(options.onError)
        .finally(() => {
          active = null;
          schedule();
        });
    }, options.intervalMs);
    timer.unref();
  };

  schedule();

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await active;
    },
  };
}
