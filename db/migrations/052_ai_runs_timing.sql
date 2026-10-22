-- Per-step timing of an assistant run (server/assistant/runTiming.ts): when the SDK agent was ready, the
-- first delta / first text, every tool call (name + milliseconds), turns, token totals, total duration.
-- Numbers and tool names only — no prompt, page or tool-argument content. Written once, when the run ends.
ALTER TABLE ai_runs ADD COLUMN IF NOT EXISTS timing jsonb;
