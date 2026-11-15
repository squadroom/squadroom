import { useEffect, useRef, useState, type ReactNode } from "react";
import styles from "./console.module.css";

// A `mermaid` code block drawn as a diagram. Mermaid is large,
// so it is loaded only when a diagram first comes on screen, never with
// the page. It draws in its strict mode: labels are text, nothing in a
// diagram is clickable or scripted.

/** Diagrams already drawn, by colour scheme and source, so one drawn while
 * a reply streamed is not drawn again when the reply is final. */
const drawn = new Map<string, string>();
const KEEP = 40;
let count = 0;

async function draw(source: string, dark: boolean): Promise<string | null> {
  const key = `${dark}\n${source}`;
  const had = drawn.get(key);
  if (had) return had;
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default" });
  if (!(await mermaid.parse(source, { suppressErrors: true }))) return null;
  const { svg } = await mermaid.render(`console-diagram-${++count}`, source);
  drawn.set(key, svg);
  if (drawn.size > KEEP) drawn.delete(drawn.keys().next().value!);
  return svg;
}

/** The Console's light or dark (Settings › Appearance, else the system's),
 * as the element inherits it. */
function isDark(el: Element, system: MediaQueryList): boolean {
  const scheme = getComputedStyle(el).colorScheme;
  return scheme === "dark" || (scheme !== "light" && system.matches);
}

/** `children` is the code block itself: shown until the diagram is drawn,
 * and kept when its source does not parse. */
export default function Diagram({ source, children }: { source: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let alive = true;
    let seen = false;
    const system = window.matchMedia("(prefers-color-scheme: dark)");
    const go = () => {
      seen = true;
      draw(source, isDark(el, system)).then(
        (made) => alive && setSvg(made),
        () => alive && setSvg(null),
      );
    };
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            if (!entries.some((e) => e.isIntersecting)) return;
            observer?.disconnect();
            go();
          });
    if (observer) observer.observe(el);
    else go();
    // Light or dark changes with the system, or with Settings › Appearance
    // (`data-appearance` on the Console's root): drawn again either way.
    const onScheme = () => seen && go();
    system.addEventListener("change", onScheme);
    const root = el.closest(`.${CSS.escape(styles.console)}`);
    const appearance = root && typeof MutationObserver !== "undefined" ? new MutationObserver(onScheme) : null;
    if (root) appearance?.observe(root, { attributes: true, attributeFilter: ["data-appearance"] });
    return () => {
      alive = false;
      observer?.disconnect();
      appearance?.disconnect();
      system.removeEventListener("change", onScheme);
    };
  }, [source]);
  return (
    <div ref={box}>
      {/* Mermaid's own output, sanitized by it (strict mode). */}
      {svg ? <div className={styles.diagram} role="img" aria-label="Diagram" dangerouslySetInnerHTML={{ __html: svg }} /> : children}
    </div>
  );
}
