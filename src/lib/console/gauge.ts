// The context gauge's line in a window header: the latest model request's
// whole input over the window the client reports. No estimate is ever
// made: with no window it shows the count alone, and with no measurement it
// says so. Browser-safe and pure.

export interface Gauge {
  tokens: number | null;
  contextWindow: number | null;
  measured: boolean;
  compactedFrom: number | null;
}

/** 1234 → "1.2k", 200000 → "200k", 1048576 → "1.0M". */
export function tokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${n < 10_000 ? (n / 1000).toFixed(1) : Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** What the header shows, its tooltip, and whether it is nearly full. */
export function gaugeLine(g: Gauge | null): { text: string; title: string; high: boolean } | null {
  if (!g) return null;
  const compacted = g.compactedFrom !== null ? ` · compacted from ${tokenCount(g.compactedFrom)}` : "";
  if (!g.measured || g.tokens === null)
    return { text: `context: not measured${compacted}`, title: "The latest request reported no usage, so the context size is not known.", high: false };
  if (!g.contextWindow)
    return {
      text: `context ${tokenCount(g.tokens)}${compacted}`,
      title: `The latest request's input: ${g.tokens.toLocaleString("en")} tokens. The client reported no context window for this model, so no percentage is shown.`,
      high: false,
    };
  const pct = Math.round((g.tokens / g.contextWindow) * 100);
  return {
    text: `context ${pct}%${compacted}`,
    title: `The latest request's input: ${g.tokens.toLocaleString("en")} of ${g.contextWindow.toLocaleString("en")} tokens (the window the client reports).`,
    high: pct >= 80,
  };
}
