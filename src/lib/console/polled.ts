// Answers the page reads again and again. A dialog that reads the same
// answer every few seconds (the changes view polls every 3 s): an answer
// equal to the last keeps the last object, so React does not draw it again.
// Overlapping reads of one view: an answer older than one already shown is
// dropped. Pure, so it is tested.

export type Polled<T> = { json: string; value: T };

export function nextPolled<T>(last: Polled<T> | null, value: T): Polled<T> {
  const json = JSON.stringify(value);
  return last && last.json === json ? last : { json, value };
}

/** Reads of one view that can overlap (a poll, and the reload after a
 * command): call the result before each read, and the check it gives when
 * the answer lands. The check is true, and the answer counts as shown,
 * unless a read started later has already been shown: an older answer
 * landing after a newer one is dropped, yet reads that keep overlapping
 * (slower than the poll) still show each answer that is the newest so far. */
export function inOrder(): () => () => boolean {
  let asked = 0;
  let shown = 0;
  return () => {
    const mine = ++asked;
    return () => {
      if (mine < shown) return false;
      shown = mine;
      return true;
    };
  };
}
