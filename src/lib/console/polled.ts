// A dialog that reads the same answer every few seconds (the changes view
// polls every 3 s): an answer equal to the last keeps
// the last object, so React does not draw an unchanged patch again. Pure,
// so it is tested.

export type Polled<T> = { json: string; value: T };

export function nextPolled<T>(last: Polled<T> | null, value: T): Polled<T> {
  const json = JSON.stringify(value);
  return last && last.json === json ? last : { json, value };
}
