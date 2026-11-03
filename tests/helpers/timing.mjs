// Timing that a fake and the tests share, so the two cannot drift apart.

/** How long fake Claude Code takes to exit after TERM, as a real client
 * takes a moment. */
export const CLAUDE_TERM_EXIT_MS = 600;
