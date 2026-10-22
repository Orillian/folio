import { useDeferredValue, useMemo } from 'react';
import { renderChatMarkdown } from './chatMarkdown';

/**
 * Tailwind arbitrary-variant rules compacting rehype's default block/inline
 * elements to read well in this panel's ~440px width — see chatMarkdown.ts
 * for the sanitize-then-stringify pipeline that produces the HTML this
 * wraps. Kept as one shared class string rather than duplicated per call
 * site (there's only the one, but it's a mouthful).
 */
const CHAT_MARKDOWN_CLASS =
  'folio-chat-md text-sm [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 ' +
  '[&_li]:my-0.5 [&_h1]:mt-2 [&_h2]:mt-2 [&_h3]:mt-2 [&_h1]:mb-1 [&_h2]:mb-1 [&_h3]:mb-1 [&_h1]:text-base [&_h2]:text-base ' +
  '[&_h3]:text-sm [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_p:first-child]:mt-0 [&_h1:first-child]:mt-0 ' +
  '[&_h2:first-child]:mt-0 [&_h3:first-child]:mt-0 [&_p:last-child]:mb-0 [&_blockquote]:my-1 [&_blockquote]:border-l-2 ' +
  '[&_blockquote]:border-neutral-300 [&_blockquote]:pl-2 [&_blockquote]:text-neutral-600 dark:[&_blockquote]:border-neutral-600 ' +
  'dark:[&_blockquote]:text-neutral-400 [&_code]:rounded [&_code]:bg-neutral-100 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[13px] ' +
  'dark:[&_code]:bg-neutral-800 [&_pre]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-neutral-100 [&_pre]:p-2 ' +
  'dark:[&_pre]:bg-neutral-800 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:my-1 [&_table]:text-xs [&_th]:border ' +
  '[&_td]:border [&_th]:border-neutral-300 [&_td]:border-neutral-300 dark:[&_th]:border-neutral-700 dark:[&_td]:border-neutral-700 ' +
  '[&_th]:px-1 [&_td]:px-1 [&_a]:underline [&_hr]:my-2 [&_hr]:border-neutral-300 dark:[&_hr]:border-neutral-700';

export interface AssistantMessageContentProps {
  text: string;
  /** Extra classes (the admin analytics cells restyle links and text size). */
  className?: string;
  /** Open every link, in-app ones included, in a new tab (a table the reader must not leave). */
  newTabLinks?: boolean;
}

/** Same markdown, but never throws: a half-written reply (unclosed fence, link or table) that the parser could not take falls back to escaped plain text. */
function renderStreamingMarkdown(text: string, newTabLinks: boolean | undefined): string {
  try {
    return renderChatMarkdown(text, { allLinksNewTab: newTabLinks });
  } catch {
    return `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`;
  }
}

/**
 * The live bubble of a streaming reply: the same renderer as AssistantMessageContent, so links, lists and
 * code are already formatted while the text arrives. `text` changes every animation frame, so it is deferred
 * (React skips intermediate values when the parse falls behind) and the parse is memoized per value.
 */
export function AssistantStreamingContent({ text, className }: { text: string; className?: string }) {
  const deferred = useDeferredValue(text);
  const html = useMemo(() => renderStreamingMarkdown(deferred, undefined), [deferred]);
  return <div className={className ? `${CHAT_MARKDOWN_CLASS} ${className}` : CHAT_MARKDOWN_CLASS} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Assistant reply body: rendered markdown (sanitized), memoized per text — see chatMarkdown.ts. */
export function AssistantMessageContent({ text, className, newTabLinks }: AssistantMessageContentProps) {
  const html = useMemo(() => renderChatMarkdown(text, { allLinksNewTab: newTabLinks }), [text, newTabLinks]);
  return <div className={className ? `${CHAT_MARKDOWN_CLASS} ${className}` : CHAT_MARKDOWN_CLASS} dangerouslySetInnerHTML={{ __html: html }} />;
}
