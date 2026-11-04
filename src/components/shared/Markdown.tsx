import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { markdownUrlTransform, SafeImage } from "@/lib/shared/markdown-image";
import CodeBlock from "./CodeBlock";
import "./markdown.css";

/** `onLink`, when given, sees every link first: true means it handled the
 * click (the Console opens agents' files in its panel); other links then
 * open in a new tab instead of leaving the page. `highlight={false}` skips
 * code highlighting (a reply still streaming). */
export default function Markdown({ children, onLink, highlight = true }: { children: string; onLink?: (href: string) => boolean; highlight?: boolean }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={highlight ? [rehypeHighlight] : []}
        // Inline images and, with a link handler, `file:` links survive
        // the sanitizing (markdown-image.ts).
        urlTransform={markdownUrlTransform(Boolean(onLink))}
        components={
          onLink
            ? {
                pre: CodeBlock,
                img: SafeImage,
                a: ({ href, children: label }) => (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => {
                      if (href && onLink(href)) e.preventDefault();
                    }}
                  >
                    {label}
                  </a>
                ),
              }
            : { pre: CodeBlock, img: SafeImage }
        }
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
