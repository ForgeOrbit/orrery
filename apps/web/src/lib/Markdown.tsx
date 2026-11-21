import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useQuery } from "@tanstack/react-query";
import mermaid from "mermaid";
import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Safe GFM renderer for user-authored content (issue descriptions and comments).
//
// react-markdown never renders raw HTML: an <script>, <img onerror=…> or inline event
// handler in the source is dropped rather than parsed, so it cannot execute. Every URL
// also goes through urlTransform below, which rejects script/data protocols before they
// reach an <a href>. The only enriched syntax is GitHub Flavored Markdown (tables, task
// lists, strikethrough, fenced code) plus fenced ```mermaid diagrams.
//
// Diagrams are rendered by mermaid.render inside a TanStack Query keyed on the diagram
// source. That keeps the work asynchronous, cached and deterministic with no useEffect
// (which apps/web forbids), and retries only when the source actually changes.

/** Only well-known, non-executable URL schemes survive; relative links are left alone. */
function safeUrl(url: string): string {
  const value = url.trim();
  // Anything with a scheme must be on the short allowlist. This rejects javascript:,
  // data:, vbscript: and look-alike protocols before they can become a link target.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return /^(https?|mailto|tel):/i.test(value) ? value : "";
  }
  return value;
}

let initialized = false;

function diagramId(source: string): string {
  // A stable id from the diagram text: the query key already guarantees one render per
  // source, and mermaid removes its temporary nodes when render() resolves.
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = (hash * 31 + source.charCodeAt(index)) | 0;
  }
  return `orrery-mermaid-${Math.abs(hash).toString(36)}`;
}

async function renderMermaid(source: string): Promise<string> {
  if (!initialized) {
    // "strict" sanitizes diagram labels and disables links/click handlers, so a hostile
    // diagram cannot smuggle HTML or script into the generated SVG.
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
    initialized = true;
  }
  const { svg } = await mermaid.render(diagramId(source), source);
  return svg;
}

function MermaidDiagram({ source }: { source: string }) {
  const result = useQuery({
    queryKey: ["mermaid-diagram", source],
    queryFn: () => renderMermaid(source),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

  if (result.isPending) {
    return (
      <Text as="p" display="block" type="supporting" color="secondary" data-mermaid-pending>
        Rendering diagram…
      </Text>
    );
  }
  if (result.isError || typeof result.data !== "string") {
    // Show the fenced source verbatim when a diagram cannot be rendered; text is inert.
    return <pre data-mermaid-error>{source}</pre>;
  }
  return (
    <figure
      className="markdown-mermaid"
      data-mermaid
      role="img"
      aria-label="Mermaid diagram"
      dangerouslySetInnerHTML={{ __html: result.data }}
    />
  );
}

const components: Components = {
  // react-markdown wraps fenced code in <pre><code>. Flatten that wrapper here so the
  // `code` renderer below can either emit a real code block or a diagram without
  // nesting a figure inside a pre.
  pre({ children }: { children?: ReactNode }) {
    return <>{children}</>;
  },
  code({ className, children, ...props }) {
    const language = /language-([\w-]+)/.exec(className ?? "")?.[1];
    const text = typeof children === "string" ? children : "";
    if (language === "mermaid") {
      return <MermaidDiagram source={text.replace(/\n$/, "")} />;
    }
    if (language !== undefined || text.endsWith("\n")) {
      return (
        <pre data-code-block>
          <code className={className} {...props}>
            {children}
          </code>
        </pre>
      );
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  a({ href, children, ...props }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    );
  },
  img({ alt }) {
    // Embedded images are not part of Orrery's rich-content contract. Showing the alt
    // text as inert text avoids tracking pixels and unsafe image URLs altogether.
    return (
      <Text as="span" type="inherit" color="secondary">
        {alt === undefined || alt === "" ? "[image]" : `[image: ${alt}]`}
      </Text>
    );
  },
};

export function Markdown({ children }: { children: string }) {
  return (
    <Stack gap={0} className="markdown-body" data-markdown>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={safeUrl}>
        {children}
      </ReactMarkdown>
    </Stack>
  );
}
