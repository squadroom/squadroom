import ReactMarkdown, { type Components, type Options } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { markdownUrlTransform, SafeImage } from "@/lib/shared/markdown-image";
import CodeBlock from "./CodeBlock";
import "./markdown.css";

// Markdown as the pages show it: GitHub-flavoured, with code highlighted and
// images and links checked first (markdown-image.ts).

/** A link under `onLink`: the handler sees the click first; a link it does
 * not handle opens in a new tab instead of leaving the page. */
export function HandledLink({ href, onLink, children }: { href?: string; onLink: (href: string) => boolean; children?: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        if (href && onLink(href)) e.preventDefault();
      }}
    >
      {children}
    </a>
  );
}

/** More than the plain rendering, for a caller that wants it (the Console's
 * maths, diagrams and inline images): plugins run before the built-in
 * ones' highlighting, components replace the built-in ones. */
export interface MarkdownExtension {
  remarkPlugins?: NonNullable<Options["remarkPlugins"]>;
  rehypePlugins?: NonNullable<Options["rehypePlugins"]>;
  components?: Components;
}

/** `onLink`, when given, sees every link first: true means it handled the
 * click (the Console opens agents' files in its panel); other links then
 * open in a new tab instead of leaving the page. `highlight={false}` skips
 * code highlighting (a reply still streaming). */
export default function Markdown({
  children,
  onLink,
  highlight = true,
  extend,
}: {
  children: string;
  onLink?: (href: string) => boolean;
  highlight?: boolean;
  extend?: MarkdownExtension;
}) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, ...(extend?.remarkPlugins ?? [])]}
        rehypePlugins={[...(extend?.rehypePlugins ?? []), ...(highlight ? [rehypeHighlight] : [])]}
        // Inline images and, with a link handler, `file:` links survive
        // the sanitizing (markdown-image.ts).
        urlTransform={markdownUrlTransform(Boolean(onLink))}
        components={{
          pre: CodeBlock,
          img: SafeImage,
          ...(onLink ? { a: ({ href, children: label }) => <HandledLink href={href} onLink={onLink}>{label}</HandledLink> } : {}),
          ...extend?.components,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
