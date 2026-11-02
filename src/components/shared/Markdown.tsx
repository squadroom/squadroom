import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { imageDecision, isInlineImage } from "@/lib/shared/markdown-image";
import CodeBlock from "./CodeBlock";
import "./markdown.css";

/** An image in rendered Markdown: shown only when inline; any URL is shown
 * as text, so the browser never fetches anything on a model's or agent's
 * behalf. Used with and without `onLink`. */
function SafeImage({ src, alt }: { src?: unknown; alt?: string }) {
  const decision = imageDecision(src, alt);
  // eslint-disable-next-line @next/next/no-img-element
  if (decision.show) return <img src={decision.src} alt={alt ?? ""} />;
  return <span>{decision.text}</span>;
}

/** `onLink`, when given, sees every link first: true means it handled the
 * click (the Console opens agents' files in its panel); other links then
 * open in a new tab instead of leaving the page. `highlight={false}` skips
 * code highlighting (a reply still streaming). */
export default function Markdown({ children, onLink, highlight = true }: { children: string; onLink?: (href: string) => boolean; highlight?: boolean }) {
  return (
    <div className="markdown text-[15px] leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={highlight ? [rehypeHighlight] : []}
        // An inline image's `data:image/…` source reaches SafeImage, and with
        // a link handler `file:` links survive to it (the default sanitizing
        // drops both); everything else is sanitized as before.
        urlTransform={(url, key) => ((key === "src" && isInlineImage(url)) || (onLink && url.startsWith("file:")) ? url : defaultUrlTransform(url))}
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
