import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { performance } from "node:perf_hooks";
import { proxyEnvironment } from "./network-environment.ts";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "./types.ts";

const DEFAULT_OUTPUT_BYTES = 16 * 1024 * 1024;
const TERMINATION_GRACE_MS = 200;
const CLOSE_AFTER_KILL_MS = 500;
const MAX_TERMINATION_GRACE_MS = 30_000;

type ManagedProcess = { terminationGraceMs: number; terminate: (signal: "SIGINT" | "SIGTERM") => void; kill: () => void };
const activeProcesses = new Set<ManagedProcess>();
let listenersInstalled = false;
let signalHandoff: NodeJS.Timeout | undefined;
let terminatingParentSignal: "SIGINT" | "SIGTERM" | null = null;

function killActiveProcesses(): void {
  for (const child of activeProcesses) child.kill();
}
function removeProcessListeners(): void {
  if (!listenersInstalled) return;
  process.removeListener("SIGINT", onParentInterrupt);
  process.removeListener("SIGTERM", onParentTerminate);
  process.removeListener("exit", onParentExit);
  listenersInstalled = false;
}
function onParentExit(): void {
  // The exit event cannot do asynchronous cleanup. Detached children must die synchronously.
  killActiveProcesses();
}
function handleParentSignal(signal: "SIGINT" | "SIGTERM", ownListener: () => void): void {
  const hasOtherListener = process.listeners(signal).some((listener) => listener !== ownListener);
  if (!hasOtherListener) terminatingParentSignal = signal;
  const maximumGraceMs = Math.max(0, ...[...activeProcesses].map((child) => child.terminationGraceMs));
  for (const child of activeProcesses) child.terminate(signal);
  // Respect a caller's custom signal policy; its handler still receives this same event normally.
  if (hasOtherListener) return;
  const restoreDefaultSignal = (): void => {
    if (signalHandoff !== undefined) clearTimeout(signalHandoff);
    signalHandoff = undefined;
    killActiveProcesses();
    removeProcessListeners();
    // A caller may have installed a custom handler while children were shutting down.
    if (process.listenerCount(signal) !== 0) {
      terminatingParentSignal = null;
      return;
    }
    try { process.kill(process.pid, signal); }
    catch { process.exit(signal === "SIGINT" ? 130 : 143); }
  };
  // A second interrupt should stop immediately instead of extending the shutdown deadline.
  if (signalHandoff !== undefined) restoreDefaultSignal();
  else signalHandoff = setTimeout(restoreDefaultSignal, maximumGraceMs + 20);
}
function onParentInterrupt(): void { handleParentSignal("SIGINT", onParentInterrupt); }
function onParentTerminate(): void { handleParentSignal("SIGTERM", onParentTerminate); }

function registerProcess(child: ManagedProcess): () => void {
  activeProcesses.add(child);
  if (!listenersInstalled) {
    // One listener per signal for the whole runner, regardless of experiment concurrency.
    // Prepend so a caller's once-listener is still visible when deciding whether to restore defaults.
    process.prependListener("SIGINT", onParentInterrupt);
    process.prependListener("SIGTERM", onParentTerminate);
    process.prependListener("exit", onParentExit);
    listenersInstalled = true;
  }
  return () => {
    activeProcesses.delete(child);
    if (activeProcesses.size === 0) removeProcessListeners();
  };
}

/** Only inherit the operating/transport environment, never unrelated provider credentials or agent state. */
function childEnvironment(overrides: ProcessRequest["env"]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = proxyEnvironment();
  for (const name of ["PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "COMSPEC", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "NO_COLOR"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...overrides };
}

/** A bounded, non-shell child process. Each POSIX child owns a process group for cancellation. */
export const runProcess: ProcessRunner = async (request): Promise<ProcessResult> => {
  const started = performance.now();
  if (terminatingParentSignal !== null) {
    return { stdout: "", stderr: "", exitCode: null, signal: null, timedOut: false, error: `Parent process received ${terminatingParentSignal}`, latencyMs: performance.now() - started };
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let error: string | null = null;
  let timedOut = false;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  const maxBytes = request.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
  const terminationGraceMs = request.terminationGraceMs ?? TERMINATION_GRACE_MS;
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || !Number.isInteger(maxBytes) || maxBytes < 1) {
    return { stdout: "", stderr: "", exitCode, signal: null, timedOut, error: "Process timeoutMs and maxOutputBytes must be positive integers", latencyMs: performance.now() - started };
  }
  if (!Number.isInteger(terminationGraceMs) || terminationGraceMs < 0 || terminationGraceMs > MAX_TERMINATION_GRACE_MS) {
    return { stdout: "", stderr: "", exitCode, signal: null, timedOut, error: "Process terminationGraceMs must be an integer between 0 and 30000", latencyMs: performance.now() - started };
  }
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(request.executable, request.args, {
        cwd: request.cwd,
        env: childEnvironment(request.env),
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (cause) {
      resolve({ stdout: "", stderr: "", exitCode: null, signal: null, timedOut: false, error: cause instanceof Error ? cause.message : String(cause), latencyMs: performance.now() - started });
      return;
    }
    let finished = false;
    let terminating = false;
    let killTimer: NodeJS.Timeout | undefined;
    let closeTimer: NodeJS.Timeout | undefined;
    let unregister = (): void => {};
    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (cause) {
        if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) {
          error ??= cause instanceof Error ? cause.message : String(cause);
        }
      }
    };
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (closeTimer !== undefined) clearTimeout(closeTimer);
      // Clean up descendants in the same group even if they have already closed their output pipes.
      signalGroup("SIGKILL");
      unregister();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode, signal: exitSignal, timedOut, error, latencyMs: performance.now() - started });
    };
    const terminate = (): void => {
      if (terminating || finished) return;
      terminating = true;
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), terminationGraceMs);
      // Descendants that detached themselves cannot hold the parent's pipes open forever.
      closeTimer = setTimeout(finish, terminationGraceMs + CLOSE_AFTER_KILL_MS);
    };
    const capture = (chunks: Buffer[], chunk: Buffer): void => {
      const available = Math.max(0, maxBytes - bytes);
      if (available > 0) chunks.push(chunk.subarray(0, available));
      bytes += chunk.length;
      if (bytes > maxBytes) {
        error ??= `Process output exceeded ${String(maxBytes)} bytes`;
        terminate();
      }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      error ??= `Process timed out after ${String(request.timeoutMs)} ms`;
      terminate();
    }, request.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.stdin.on("error", (cause: NodeJS.ErrnoException) => {
      // A CLI can reject options before reading its input. Preserve its own exit diagnostics.
      if (cause.code !== "EPIPE" && cause.code !== "ERR_STREAM_DESTROYED") error ??= cause.message;
    });
    child.on("error", (cause) => {
      error ??= cause.message;
      finish();
    });
    child.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });
    child.on("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      finish();
    });
    unregister = registerProcess({
      terminationGraceMs,
      terminate: (signal) => {
        error ??= `Parent process received ${signal}`;
        terminate();
      },
      kill: () => signalGroup("SIGKILL"),
    });
    child.stdin.end(request.stdin ?? "");
  });
};
