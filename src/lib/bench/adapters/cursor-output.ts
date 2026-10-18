import path from "node:path";
import type { ExecutionEvent, ParsedHarnessResult, ProcessResult } from "../types.ts";

type ExpectedCursorRun = { workspace: string; auth: "cursor-login" | "cursor-api-key" };
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim() !== ""; }

/** Cursor's terminal result is authoritative; assistant events can contain duplicate flushes. */
export function parseCursorOutput(result: ProcessResult, expected?: ExpectedCursorRun): ParsedHarnessResult {
  const events: ExecutionEvent[] = [];
  let error = result.error;
  let sessionId: string | null = null;
  let initialized = false;
  let terminal = false;
  let completed = false;
  let text = "";
  for (const line of result.stdout.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch {
      events.push({ type: "raw", data: line });
      error ??= "Cursor Agent emitted malformed JSON events";
      continue;
    }
    events.push({ type: "raw", data: value });
    const event = record(value);
    if (event === null || typeof event.type !== "string") { error ??= "Cursor Agent emitted invalid event data"; continue; }
    if (terminal) error ??= "Cursor Agent emitted events after its terminal result";
    if (event.type === "system" && event.subtype === "init") {
      if (initialized || !nonempty(event.session_id)) error ??= "Cursor Agent emitted invalid or duplicate session initialization";
      else { initialized = true; sessionId = event.session_id; }
      if (expected !== undefined) {
        if (typeof event.cwd !== "string" || !path.isAbsolute(event.cwd) || path.resolve(event.cwd) !== path.resolve(expected.workspace)) {
          error ??= "Cursor Agent workspace did not match the frozen run";
        }
        const source = expected.auth === "cursor-login" ? "login" : "env";
        if (event.apiKeySource !== source) error ??= "Cursor Agent authentication source did not match the target";
      }
      events.push({ type: "session", data: event });
    }
    if (event.session_id !== undefined && (sessionId === null || event.session_id !== sessionId)) {
      error ??= "Cursor Agent emitted an inconsistent session ID";
    }
    if (event.type === "assistant") events.push({ type: "message", data: event });
    if (event.type === "tool_call") events.push({ type: "tool", data: event });
    if (event.type === "error") {
      error ??= typeof event.message === "string" ? event.message : "Cursor Agent reported a stream error";
      events.push({ type: "error", data: event });
    }
    if (event.type === "result") {
      terminal = true;
      if (!initialized || event.session_id !== sessionId) error ??= "Cursor Agent result has no matching session";
      if (event.subtype !== "success" || event.is_error !== false || typeof event.result !== "string") {
        error ??= typeof event.result === "string" ? event.result : "Cursor Agent did not return a successful terminal result";
      } else {
        text = event.result;
        completed = true;
      }
      // Native usage may contain synthesized zeros and omit retry attempts.
      // Preserve it as evidence without claiming a complete billable run total.
      if (event.usage !== undefined) events.push({ type: "usage", data: event.usage });
    }
  }
  if (result.timedOut) error ??= "Cursor Agent timed out";
  else if (result.exitCode !== 0 || result.signal !== null) error ??= `Cursor Agent exited with ${result.signal ?? String(result.exitCode)}`;
  else if (!completed) error ??= "Cursor Agent ended without a terminal completion event";
  return {
    status: result.timedOut ? "timeout" : error !== null || !completed ? "failed" : "completed",
    text, reasoning: null, usage: null, cost: null, sessionId,
    // init.model is a display label, not proof of a resolved model/version ID.
    responseModel: null, events, error,
  };
}
