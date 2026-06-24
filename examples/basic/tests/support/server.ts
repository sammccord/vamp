import { type ChildProcess, spawn } from "node:child_process";

/** Boot a local `wrangler dev` server and resolve once it is ready. */
export function startWranglerDev(): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "./node_modules/.bin/wrangler",
      ["dev", "--ip", "127.0.0.1", "--port", "0", "--log-level", "log"],
      { cwd: process.cwd(), env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" } },
    );

    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const inspect = (chunk: Buffer) => {
      const text = chunk.toString();
      if (/Build failed|\[ERROR\]/i.test(text))
        fail(new Error(`wrangler dev build error: ${text}`));
      const match = text.match(/Ready on https?:\/\/([\d.]+):(\d+)/i);
      if (match && !settled) {
        settled = true;
        resolve({ proc, port: Number(match[2]) });
      }
    };
    proc.stdout?.on("data", inspect);
    proc.stderr?.on("data", inspect);
    proc.on("exit", (code) => fail(new Error(`wrangler dev exited early (code ${code})`)));
    setTimeout(() => fail(new Error("wrangler dev did not become ready in time")), 45_000);
  });
}

/** Poll until `poll()` returns a defined value, or reject on timeout. */
export function waitFor<T>(
  poll: () => T | undefined,
  { timeout = 10_000, label = "condition" }: { timeout?: number; label?: string } = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const value = poll();
      if (value !== undefined) return resolve(value);
      if (Date.now() - start > timeout) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}
