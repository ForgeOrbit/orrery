import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useQuery } from "@tanstack/react-query";
import mermaid from "mermaid";
import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "./Link.tsx";

export interface IssueReference {
  id: string;
  number: number;
  identifier: string;
  title: string;
}

interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  title?: string;
  children?: MdastNode[];
}

const SKIP_REF_PARENTS = new Set(["link", "linkReference", "code", "inlineCode", "definition"]);

function createIssueRefPlugin(issueRefs: readonly IssueReference[]) {
  const byNumber = new Map<number, IssueReference>();
  const byIdentifier = new Map<string, IssueReference>();
  for (const ref of issueRefs) {
    byNumber.set(ref.number, ref);
    byIdentifier.set(ref.identifier.toUpperCase(), ref);
  }
  const pattern = /(?<![\w/])(?:#(\d+)|([A-Z][A-Z0-9]{1,9}-\d+))\b/g;

  function transformChildren(parent: MdastNode) {
    if (!Array.isArray(parent.children) || SKIP_REF_PARENTS.has(parent.type)) return;
    const next: MdastNode[] = [];
    for (const child of parent.children) {
      if (child.type !== "text" || typeof child.value !== "string") {
        transformChildren(child);
        next.push(child);
        continue;
      }
      const text = child.value;
      pattern.lastIndex = 0;
      let cursor = 0;
      let matched = false;
      for (const match of text.matchAll(pattern)) {
        const start = match.index;
        const raw = match[0];
        const numGroup = match[1];
        const keyGroup = match[2];
        const ref =
          numGroup !== undefined
            ? byNumber.get(Number(numGroup))
            : keyGroup !== undefined
              ? byIdentifier.get(keyGroup.toUpperCase())
              : undefined;
        if (ref === undefined) continue;
        matched = true;
        if (start > cursor) {
          next.push({ type: "text", value: text.slice(cursor, start) });
        }
        next.push({
          type: "link",
          url: `/issues/${ref.id}`,
          title: `${ref.identifier}: ${ref.title}`,
          children: [{ type: "text", value: raw }],
        });
        cursor = start + raw.length;
      }
      if (!matched) {
        next.push(child);
      } else if (cursor < text.length) {
        next.push({ type: "text", value: text.slice(cursor) });
      }
    }
    parent.children = next;
  }

  return () => (tree: MdastNode) => {
    transformChildren(tree);
  };
}

function safeUrl(url: string): string {
  // eslint-disable-next-line no-control-regex -- intentional: strip control characters from untrusted URLs.
  const value = url.replace(/[\u0000-\u001f\u007f]+/g, "").trim();
  const colon = value.indexOf(":");
  const boundaries = [value.indexOf("/"), value.indexOf("?"), value.indexOf("#")].filter(
    (index) => index >= 0,
  );
  const firstBoundary =
    boundaries.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...boundaries);

  if (colon >= 0 && colon < firstBoundary) {
    return /^(https?|mailto|tel):/i.test(value) ? value : "";
  }
  return value;
}

let initialized = false;

function diagramId(source: string): string {
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = (hash * 31 + source.charCodeAt(index)) | 0;
  }
  return `orrery-mermaid-${Math.abs(hash).toString(36)}`;
}

async function renderMermaid(source: string): Promise<string> {
  if (!initialized) {
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
  pre({ children }: { children?: ReactNode }) {
    return <>{children}</>;
  },
  code({ className, children, node: _node, ...props }) {
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
  a({ href, title, children, node: _node, ...props }) {
    if (!href) {
      return (
        <Text as="span" type="inherit" color="secondary">
          {children}
        </Text>
      );
    }
    const issueMatch = /^\/issues\/([0-9a-f-]+)$/i.exec(href);
    if (issueMatch?.[1] !== undefined) {
      return (
        <Link to="/issues/$issueId" params={{ issueId: issueMatch[1] }} className="issue-ref-link">
          <span title={title}>{children}</span>
        </Link>
      );
    }
    return (
      <a href={href} title={title} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    );
  },
  img({ alt }) {
    return (
      <Text as="span" type="inherit" color="secondary">
        {alt === undefined || alt === "" ? "[image]" : `[image: ${alt}]`}
      </Text>
    );
  },
};

export function Markdown({
  children,
  issueRefs,
}: {
  children: string;
  issueRefs?: readonly IssueReference[];
}) {
  const plugins =
    issueRefs !== undefined && issueRefs.length > 0
      ? [remarkGfm, createIssueRefPlugin(issueRefs)]
      : [remarkGfm];
  return (
    <Stack gap={0} className="markdown-body" data-markdown>
      <ReactMarkdown remarkPlugins={plugins} components={components} urlTransform={safeUrl}>
        {children}
      </ReactMarkdown>
    </Stack>
  );
}
