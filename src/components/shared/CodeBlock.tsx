"use client";

import { useRef, useState } from "react";
import type { ExtraProps } from "react-markdown";
import Icon from "./Icon";

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

  // Placed in markdown.css; its colours are the page's button colours.
  return (
    <div className="code-block">
      <pre ref={preRef} {...preProps} />
      <button type="button" onClick={copy} aria-label="Copy code" className="code-copy" data-copied={copied || undefined}>
        <Icon name={copied ? "check" : "copy"} size={14} />
        <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}
