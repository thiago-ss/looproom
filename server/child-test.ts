import type { ChildProcess } from "node:child_process";

export function waitForChildExit(child: ChildProcess, output: () => string, timeoutMs = 15000): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onExit = (code: number | null) => { cleanup(); resolve(code); };
    const onError = (error: Error) => { cleanup(); reject(new Error(`Child process failed: ${error.message}\n${output()}`)); };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Child process did not exit within ${timeoutMs} ms (pid ${child.pid ?? "unknown"}).\n${output()}`));
    }, timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
    if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode);
  });
}

export async function stopChild(child: ChildProcess, output: () => string): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitForChildExit(child, output, 2000);
    return;
  } catch {
    if (child.exitCode !== null || child.signalCode !== null) return;
  }
  child.kill("SIGKILL");
  await waitForChildExit(child, output, 2000);
}
