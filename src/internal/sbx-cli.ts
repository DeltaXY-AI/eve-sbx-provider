import { spawn } from "node:child_process";

// Shared launcher: no host shell interprets command arguments.
export function launchSbx(args: string[], signal?: AbortSignal, executable = "sbx") {
  signal?.throwIfAborted();
  return spawn(executable, ["--no-input", ...args], {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    ...(signal ? { signal } : {}),
  });
}

export type SbxBytesResult = {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
};

export function runSbxBytes(
  args: string[],
  input?: Uint8Array,
  signal?: AbortSignal,
  executable?: string,
): Promise<SbxBytesResult> {
  return new Promise((resolve, reject) => {
    const child = launchSbx(args, signal, executable);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // An early command failure can close stdin; preserve its exit diagnostics.
      if (error.code !== "EPIPE") reject(error);
    });
    child.on("close", (exitCode, signal) => {
      if (exitCode === null) {
        reject(new Error(`sbx terminated by signal: ${signal}`));
        return;
      }
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(input);
  });
}

export async function runSbx(args: string[], signal?: AbortSignal, executable?: string) {
  const result = await runSbxBytes(args, undefined, signal, executable);
  return { ...result, stdout: result.stdout.toString("utf8") };
}
