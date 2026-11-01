"use client";

import { useRef, useState } from "react";
import type { ExtraProps } from "react-markdown";
import { CheckIcon, CopyIcon } from "./Icons";

// Fenced code block with an always-visible copy button (phone-first: there
// is no hover). react-markdown renders every <pre> through this component;
// the text is read from the DOM so it works however the highlighter nests
// the children.
export default function CodeBlock(props: React.HTMLAttributes<HTMLPreElement> & ExtraProps) {
  // react-markdown attaches its hast `node`; strip it so only real DOM
  // attributes reach the <pre>.
  const { node, ...preProps } = props;
  void node;
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  async function copy() {
    const text = preRef.current?.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (non-secure context); nothing useful to show.
    }
  }

  return (
    <div className="relative">
      <pre ref={preRef} {...preProps} />
      <button
        type="button"
        onClick={copy}
        aria-label="Copy code"
        className="absolute right-2 top-2 inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white/90 px-2.5 text-[11px] font-medium text-zinc-600 shadow-sm backdrop-blur hover:bg-white dark:border-zinc-700 dark:bg-zinc-900/90 dark:text-zinc-300 dark:hover:bg-zinc-900"
      >
        {copied ? (
          <CheckIcon className="h-3.5 w-3.5 text-emerald-600" />
        ) : (
          <CopyIcon className="h-3.5 w-3.5" />
        )}
        <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}
