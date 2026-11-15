import { createContext, useContext, useMemo } from "react";
import type { ExtraProps } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import CodeBlock from "@/components/shared/CodeBlock";
import Markdown, { HandledLink, type MarkdownExtension } from "@/components/shared/Markdown";
import { imagePath } from "@/lib/console/files";
import { SafeImage } from "@/lib/shared/markdown-image";
import { mermaidSource, proseDollars, type TreeNode } from "@/lib/console/rich";
import AgentImage from "./AgentImage";
import Diagram from "./Diagram";

// Markdown as the Console draws it: an agent's reply or a
// Markdown file, with maths (`$…$`, `$$…$$`; KaTeX, its styles and fonts
// served by the app), `mermaid` code blocks as diagrams and, in a
// conversation, the agent's own image files in place.

/** Whose images a conversation shows in place: the agent, and how a link
 * it wrote resolves to a file in its folder (null: not one). */
export interface AgentImages {
  agentId: string;
  resolve: (href: string) => string | null;
}

/** What the components below need from the Markdown they are drawn in.
 * They are fixed components, not made per render, so an image or diagram
 * keeps what it loaded when its reply is drawn again. */
const Drawn = createContext<{ onLink?: (href: string) => boolean; images?: AgentImages }>({});

function Pre(props: React.HTMLAttributes<HTMLPreElement> & ExtraProps) {
  const source = mermaidSource(props.node as TreeNode | undefined);
  const code = <CodeBlock {...props} />;
  return source === null ? code : <Diagram source={source}>{code}</Diagram>;
}

/** The image a link or Markdown image points at, drawn in place. */
function InPlace({ href, alt }: { href: unknown; alt: string }) {
  const { onLink, images } = useContext(Drawn);
  const path = images && onLink && typeof href === "string" ? imagePath(images.resolve, href) : null;
  return path ? <AgentImage agentId={images!.agentId} path={path} alt={alt} onOpen={() => onLink!(href as string)} /> : null;
}

function Image({ src, alt }: { src?: unknown; alt?: string }) {
  const { images } = useContext(Drawn);
  // Anything but the agent's own image file stays as it was: text, unless inline.
  return images && typeof src === "string" && imagePath(images.resolve, src) ? <InPlace href={src} alt={alt ?? ""} /> : <SafeImage src={src} alt={alt} />;
}

function Link({ href, children }: { href?: string; children?: React.ReactNode }) {
  const { onLink } = useContext(Drawn);
  if (!onLink) return <a href={href}>{children}</a>;
  return (
    <>
      <HandledLink href={href} onLink={onLink}>
        {children}
      </HandledLink>
      <InPlace href={href} alt="" />
    </>
  );
}

// `trust` stays off (no `\href`, no `\includegraphics`); a formula that does
// not parse is shown as its source. Maths runs before code highlighting.
const MATHS: MarkdownExtension = { remarkPlugins: [remarkMath], rehypePlugins: [rehypeKatex] };
const WHOLE: MarkdownExtension = { ...MATHS, components: { pre: Pre, img: Image, a: Link } };
/** A piece still growing: its code block is not yet a whole diagram. */
const GROWING: MarkdownExtension = { ...MATHS, components: { img: Image, a: Link } };

/** `highlight={false}` is a reply's piece still streaming. */
export default function RichMarkdown({
  children,
  onLink,
  highlight = true,
  images,
}: {
  children: string;
  onLink?: (href: string) => boolean;
  highlight?: boolean;
  images?: AgentImages;
}) {
  const drawn = useMemo(() => ({ onLink, images }), [onLink, images]);
  return (
    <Drawn.Provider value={drawn}>
      <Markdown onLink={onLink} highlight={highlight} extend={highlight ? WHOLE : GROWING}>
        {proseDollars(children)}
      </Markdown>
    </Drawn.Provider>
  );
}
