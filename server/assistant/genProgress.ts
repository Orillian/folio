/**
 * Live "the model is generating, but nothing is visible yet" progress for an assistant run.
 *
 * The Cursor SDK reports a model turn that has not produced reply text yet through three updates that
 * runs.ts used to ignore: `thinking-delta` (reasoning), `partial-tool-call` (the arguments of a tool call
 * are being written, e.g. a whole page for create_page) and `token-delta` (a token counter). A page of
 * 5 000 tokens takes a minute to write and the user saw a static "analyzing" line all that time.
 *
 * This tracker turns those updates into a throttled `GenerationProgress` (phase, tool name, ~tokens) and
 * NOTHING ELSE: the thinking text and the tool arguments (the page being written) are only measured, never
 * stored, forwarded or logged.
 *
 * Token count: the sum of `token-delta.tokens` since the model call began (verified live: each update is an
 * increment, not a running total), else ~chars/4 of the thinking text or of the partial tool arguments
 * (measured lazily, only when an update is emitted). One exception, also verified live: right after a tool
 * finishes the SDK reports the tool RESULT it feeds back to the model as one big `token-delta` (thousands of
 * tokens for a skill or a page) — that is input, not generation, so token-deltas are ignored from
 * `tool-call-completed` until the model's next thinking / text / partial-tool-call update.
 */

/** The part of an SDK `InteractionUpdate` this module reads — structural on purpose, so it needs no SDK import and a test needs no SDK. */
export interface SdkUpdateLike {
  type: string;
  [key: string]: unknown;
}

export interface GenerationProgress {
  phase: 'thinking' | 'tool';
  /** The tool whose arguments are being written; null while thinking, or when the SDK has not named it yet. */
  tool: string | null;
  /** Approximate tokens generated so far in this model call. */
  tokens: number;
}

export interface GenerationProgressTracker {
  /** Feed every SDK update. May call `onProgress` (throttled). */
  handle: (update: SdkUpdateLike) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Name of the tool in a `partial-tool-call` update. For a custom (in-process MCP) tool the SDK reports `type: 'mcp'` with the real name in `args.toolName`. */
export function partialToolName(toolCall: unknown): string | null {
  if (!isRecord(toolCall)) return null;
  const args = isRecord(toolCall.args) ? toolCall.args : null;
  if (toolCall.type === 'mcp') return typeof args?.toolName === 'string' && args.toolName ? args.toolName : null;
  if (typeof toolCall.name === 'string' && toolCall.name) return toolCall.name;
  return typeof toolCall.type === 'string' && toolCall.type ? toolCall.type : null;
}

/**
 * The real name of a tool call for the status line. A custom (in-process MCP) tool is reported by the SDK as
 * `mcp` — in `tool-call-started` as `toolCall.type`, in the message `tool_call` event as `name` — with the actual
 * name in `args.toolName`; any other tool keeps its own name.
 */
export function realToolName(name: string, args: unknown): string {
  if (name !== 'mcp') return name;
  const toolName = isRecord(args) ? args.toolName : undefined;
  return typeof toolName === 'string' && toolName ? toolName : name;
}

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

export function createGenerationProgress(options: {
  /** Minimum gap between two emissions with the same phase and tool. */
  intervalMs: number;
  now?: () => number;
  onProgress: (progress: GenerationProgress) => void;
}): GenerationProgressTracker {
  const now = options.now ?? Date.now;
  // Muted while reply text streams (the user sees the text itself) and while a tool executes.
  let muted = false;
  let phase: 'thinking' | 'tool' = 'thinking';
  let tool: string | null = null;
  let tokenSum = 0;
  // After a tool finishes, its result is reported as token-deltas (input, not generation) until the model speaks again.
  let ingestingToolResult = false;
  let thinkingChars = 0;
  let partialArgs: unknown;
  let lastEmit = 0;
  let lastPhase: string | null = null;
  let lastTool: string | null = null;

  const resetCounters = (): void => {
    phase = 'thinking';
    tool = null;
    tokenSum = 0;
    thinkingChars = 0;
    partialArgs = undefined;
    lastPhase = null;
    lastTool = null;
  };

  const emit = (): void => {
    if (muted) return;
    const at = now();
    if (phase === lastPhase && tool === lastTool && at - lastEmit < options.intervalMs) return;
    lastEmit = at;
    lastPhase = phase;
    lastTool = tool;
    const chars = phase === 'thinking' ? thinkingChars : jsonLength(partialArgs);
    const tokens = tokenSum > 0 ? tokenSum : Math.ceil(chars / 4);
    options.onProgress({ phase, tool, tokens: Math.max(0, Math.round(tokens)) });
  };

  return {
    handle(update) {
      switch (update.type) {
        case 'text-delta':
          muted = true;
          ingestingToolResult = false;
          resetCounters();
          return;
        case 'tool-call-started':
          muted = true;
          resetCounters();
          return;
        case 'tool-call-completed':
          muted = false;
          resetCounters();
          ingestingToolResult = true;
          return;
        case 'step-started':
          muted = false;
          resetCounters();
          ingestingToolResult = false;
          return;
        case 'thinking-delta': {
          muted = false;
          ingestingToolResult = false;
          phase = 'thinking';
          tool = null;
          partialArgs = undefined;
          thinkingChars += typeof update.text === 'string' ? update.text.length : 0;
          emit();
          return;
        }
        case 'partial-tool-call': {
          muted = false;
          ingestingToolResult = false;
          phase = 'tool';
          const toolCall = update.toolCall;
          tool = partialToolName(toolCall) ?? tool;
          partialArgs = isRecord(toolCall) ? toolCall.args : undefined;
          emit();
          return;
        }
        case 'token-delta': {
          // Muted (reply text streaming / a tool running): these deltas are the text itself or the arguments of the
          // call that is about to start — one lump of thousands of tokens that would otherwise show up as "thinking".
          if (muted || ingestingToolResult) return;
          const tokens = typeof update.tokens === 'number' && Number.isFinite(update.tokens) ? update.tokens : 0;
          if (tokens > 0) tokenSum += tokens;
          emit();
          return;
        }
        default:
          return;
      }
    },
  };
}
