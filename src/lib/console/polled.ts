// Answers the page reads again and again. A dialog that reads the same
// answer every few seconds (the changes view polls every 3 s): an answer
// equal to the last keeps the last object, so React does not draw it again.
// Overlapping reads of one view: only the latest one's answer counts. Pure,
// so it is tested.

export type Polled<T> = { json: string; value: T };

export function nextPolled<T>(last: Polled<T> | null, value: T): Polled<T> {
  const json = JSON.stringify(value);
  return last && last.json === json ? last : { json, value };
}

/** Reads of one view that can overlap (a poll, and the reload after a
 * command): call the result before each read; the check it gives stays
 * true only while no later read has started, so an older answer that lands
 * last is dropped instead of replacing a newer one. */
export function latestOnly(): () => () => boolean {
  let asked = 0;
  return () => {
    const mine = ++asked;
    return () => mine === asked;
  };
}
