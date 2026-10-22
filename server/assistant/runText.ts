/** Pure helpers for the text a run accumulates from the SDK's `text-delta` stream. */

/**
 * The SDK's text deltas of separate model turns arrive glued ("…format.Looking…"): the model does not emit a
 * newline between its narration before a tool call and after it. When `gap` (a tool call or another
 * non-text event happened since the last text) and the text so far does not end in a newline, the new chunk
 * is preceded by a blank line so markdown renders separate paragraphs.
 */
export function withParagraphGap(current: string, chunk: string, gap: boolean): string {
  if (!gap || !chunk || !current || current.endsWith('\n') || chunk.startsWith('\n')) return chunk;
  return `\n\n${chunk}`;
}

const stripWhitespace = (text: string): string => text.replace(/\s+/g, '');

/**
 * The text to persist as the final message. The SDK's own final result is the same words as the streamed
 * text but without our paragraph gaps; when the two differ only in whitespace the streamed text wins, so
 * the saved message reads like the live bubble did. If they differ in any other way (the result carries
 * only the last turn, say) the SDK's result is kept, as before.
 */
export function reconcileFinalText(streamed: string, reply: string): string {
  const live = streamed.trim();
  if (live && stripWhitespace(live) === stripWhitespace(reply)) return live;
  return reply;
}
