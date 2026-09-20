/**
 * markdown-renderer
 *
 * ported verbatim from hp635738-pro/compo (markdown-renderer + CodeBlock copy button). Changes for HPOS/Vite: removed "use client", prism styles import switched to the ESM build.
 */

import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";

/* ------------------------------------------------------------------ */
/* Code block with language header + interactive copy button           */
/* ------------------------------------------------------------------ */
function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // clipboard can be blocked in iframes — fall back to execCommand
      try {
        const ta = document.createElement("textarea");
        ta.value = code;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        // ignore
      }
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="group my-4 overflow-hidden rounded-xl border border-white/10 bg-[#141417]">
      <div className="flex items-center justify-between border-b border-white/10 bg-[#1d1e22] px-4 py-2">
        <span className="font-mono text-[11px] tracking-wider text-white/50 uppercase">
          {language}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
            copied
              ? "text-emerald-400"
              : "text-white/50 hover:bg-white/10 hover:text-white"
          }`}
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5" /> Copied!
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" /> Copy
            </>
          )}
        </button>
      </div>
      <SyntaxHighlighter
        language={language}
        style={vscDarkPlus}
        showLineNumbers
        customStyle={{
          margin: 0,
          padding: "14px 16px",
          background: "transparent",
          fontSize: "13px",
          lineHeight: 1.6,
        }}
        lineNumberStyle={{ minWidth: "2.2em", opacity: 0.4 }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Markdown renderer with rich, dark-friendly styling                  */
/* ------------------------------------------------------------------ */
export function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="max-w-none text-sm leading-relaxed break-words text-white/90">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mt-5 mb-3 text-2xl font-semibold text-white first:mt-0">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-5 mb-2.5 text-xl font-semibold text-white first:mt-0">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-4 mb-2 text-lg font-semibold text-white first:mt-0">
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 className="mt-3 mb-1.5 text-base font-semibold text-white first:mt-0">
              {children}
            </h4>
          ),
          p: ({ children }) => (
            <p className="my-2.5 first:mt-0 last:mb-0">{children}</p>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-white">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-[#1EAEDB] underline decoration-[#1EAEDB]/40 underline-offset-2 hover:decoration-[#1EAEDB]"
            >
              {children}
            </a>
          ),
          ul: ({ children }) => (
            <ul className="my-2.5 list-disc space-y-1.5 pl-5 marker:text-[#F97316]/70">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="my-2.5 list-decimal space-y-1.5 pl-5 marker:text-white/50">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-3 border-l-2 border-[#F97316]/60 bg-[#F97316]/5 py-1.5 pr-3 pl-4 text-white/70 italic">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-4 border-white/10" />,
          table: ({ children }) => (
            <div className="my-4 overflow-x-auto rounded-lg border border-white/10">
              <table className="w-full border-collapse text-[13px]">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-white/[0.06]">{children}</thead>
          ),
          th: ({ children }) => (
            <th className="px-3 py-2 text-left font-semibold text-white">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-t border-white/10 px-3 py-2 text-white/80">
              {children}
            </td>
          ),
          tr: ({ children }) => (
            <tr className="even:bg-white/[0.03] hover:bg-white/[0.05]">
              {children}
            </tr>
          ),
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || "");
            const text = String(children).replace(/\n$/, "");
            if (match || text.includes("\n")) {
              return (
                <CodeBlock language={match ? match[1] : "text"} code={text} />
              );
            }
            return (
              <code
                className="rounded-md border border-white/10 bg-white/[0.08] px-1.5 py-0.5 font-mono text-[12px] text-[#F0B47A]"
                {...props}
              >
                {children}
              </code>
            );
          },
          pre: ({ children }) => <>{children}</>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export default MarkdownRenderer;
