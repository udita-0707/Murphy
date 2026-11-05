import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

interface Managed {
  name: string;
  child: ChildProcess;
  plannedExit: boolean;
  exited: Promise<void>;
}

/**
 * Starts and stops the real processes. They run as `node --import tsx` directly: through pnpm, a
 * SIGKILL would hit the wrapper and leave the actual worker running.
 */
export class Processes {
  private readonly live = new Set<Managed>();
  readonly unexpectedExits: string[] = [];

  constructor(private readonly logDir: string) {
    process.on("exit", () => {
      for (const m of this.live) m.child.kill("SIGKILL");
    });
  }

  start(options: {
    name: string;
    cwd: string;
    script: string;
    env: Record<string, string>;
    /** Output goes to a log file unless the caller reads it. */
    pipeStdout?: boolean;
  }): Managed & { child: ChildProcess } {
    const out = openSync(path.join(this.logDir, `${options.name}.log`), "a");
    const child = spawn(process.execPath, ["--import", "tsx", options.script], {
      cwd: path.join(REPO_ROOT, options.cwd),
      // PATH and HOME only: nothing from the developer's environment can leak into a run, and
      // everything else is set explicitly so no process falls back to .env values.
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...options.env },
      stdio: ["ignore", options.pipeStdout ? "pipe" : out, out],
    });
    const managed: Managed = {
      name: options.name,
      child,
      plannedExit: false,
      exited: new Promise((resolve) => {
        child.on("exit", (code, signal) => {
          this.live.delete(managed);
          closeSync(out);
          if (!managed.plannedExit) {
            this.unexpectedExits.push(
              `${options.name} exited on its own (code ${code}, signal ${signal})`,
            );
          }
          resolve();
        });
      }),
    };
    this.live.add(managed);
    return managed;
  }

  async kill(managed: Managed): Promise<void> {
    managed.plannedExit = true;
    managed.child.kill("SIGKILL");
    await managed.exited;
  }

  /** Graceful stop, falling back to SIGKILL so a run can never hang here. */
  async stop(managed: Managed, timeoutMs = 10_000): Promise<void> {
    managed.plannedExit = true;
    managed.child.kill("SIGTERM");
    const timer = setTimeout(() => managed.child.kill("SIGKILL"), timeoutMs);
    await managed.exited;
    clearTimeout(timer);
  }
}

export type { Managed };
