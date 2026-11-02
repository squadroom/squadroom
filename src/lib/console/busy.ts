// One at a time: a second call while the first is
// still running gets the first one's promise instead of starting another.
// A double click on Create makes one project, not two clones; two commands
// that both need a fresh e-mail code share one code dialog, so neither
// waits on a dialog that was replaced. Pure, so it is tested.

export function oneAtATime<A extends unknown[], T>(fn: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
  let running: Promise<T> | null = null;
  return (...args: A) => {
    if (running) return running;
    const started = (async () => fn(...args))();
    running = started;
    const free = () => {
      running = null;
    };
    started.then(free, free);
    return started;
  };
}
