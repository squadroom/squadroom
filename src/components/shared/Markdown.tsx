import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { imageDecision, isInlineImage } from "@/lib/shared/markdown-image";
import CodeBlock from "./CodeBlock";
import "./markdown.css";

/** An image in an agent's Markdown (Console mode): fetched only from the
 * page's own origin (or inline); any other URL is shown as text, so the
 * browser never calls out on an agent's behalf. */
function ConsoleImage({ src, alt }: { src?: unknown; alt?: string }) {
  const decision = imageDecision(src, alt, typeof window === "undefined" ? "" : window.location.origin);
  // eslint-disable-next-line @next/next/no-img-element
  if (decision.show) return <img src={decision.src} alt={alt ?? ""} />;
  return <span>{decision.text}</span>;
}

/** `onLink`, when given, sees every link first: true means it handled the
 * click (the Console opens agents' files in its panel); other links then
 * open in a new tab instead of leaving the page. */
export default function Markdown({ children, onLink }: { children: string; onLink?: (href: string) => boolean }) {
  return (
    <div className="markdown text-[15px] leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        // With a link handler, `file:` links survive to it, and an inline
        // image's `data:image/…` source reaches ConsoleImage (the default
        // sanitizing drops both); everything else is sanitized as before.
        urlTransform={onLink ? (url, key) => (url.startsWith("file:") || (key === "src" && isInlineImage(url)) ? url : defaultUrlTransform(url)) : undefined}
        components={
          onLink
            ? {
                pre: CodeBlock,
                img: ConsoleImage,
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
            : { pre: CodeBlock }
        }
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
