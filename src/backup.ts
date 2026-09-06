import { PassThrough } from "node:stream";
import type { Config } from "./config";
import { parseConnectionString } from "./connection-string";
import { type AttemptState, type DumpBinary, detectDumpBinary, planRetry, runDump } from "./dump";
import { errorMessage } from "./log";
import type { BackupSink } from "./zip-sink";

export type BackupPhase = "dump" | "upload";

export type BackupProgress = {
  phase: BackupPhase;
  bytesSql: number;
  bytesZip: number;
};

export type BackupResult = {
  busy: false;
  sizeBytes: number;
  rawBytes: number;
  sha256: string;
  durationMs: number;
  warnings: string[];
  database: string;
  dumpBinary: DumpBinary;
  location?: string;
};

export type BackupOutcome = BackupResult | { busy: true };

export type RunBackupInput = {
  config: Config;
  sink: BackupSink;
  entryName?: string;
  timeoutMs?: number;
  onProgress?: (progress: BackupProgress) => void;
  signal?: AbortSignal;
};

export type BackupNames = {
  zipName: string;
  entryName: string;
};

let running = false;
let cancelActive: ((reason: Error) => void) | null = null;

export function isBackupRunning(): boolean {
  return running;
}

export function cancelRunningBackup(reason = "Backup cancelled"): void {
  cancelActive?.(new Error(reason));
}

export function sanitizeSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized.length > 0 ? sanitized : "backup";
}

export function formatBackupStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const time = `${pad(date.getUTCHours())}-${pad(date.getUTCMinutes())}-${pad(date.getUTCSeconds())}`;
  return `${day}_${time}`;
}

export function buildBackupNames(database: string, date: Date): BackupNames {
  const stem = `${sanitizeSegment(database)}-${formatBackupStamp(date)}Z`;
  return { zipName: `${stem}.zip`, entryName: `${stem}.sql` };
}

export async function runBackup(input: RunBackupInput): Promise<BackupOutcome> {
  if (running) return { busy: true };
  running = true;

  const startedAt = Date.now();
  let cancelled: Error | null = null;
  let active: { kill: () => void; abort: () => Promise<void> } | null = null;

  const cancel = (reason: Error) => {
    cancelled ??= reason;
    active?.kill();
    void active?.abort().catch(() => {});
  };
  cancelActive = cancel;

  const timeoutMs = input.timeoutMs ?? input.config.timeoutMinutes * 60_000;
  const deadline = setTimeout(() => {
    cancel(new Error(`Backup exceeded the time limit (${Math.round(timeoutMs / 60_000)} min)`));
  }, timeoutMs);
  const onAbort = () => cancel(new Error("Backup cancelled"));
  input.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const target = parseConnectionString(input.config.connectionString);
    const binary = await detectDumpBinary({
      explicitPath: input.config.dumpBin.length > 0 ? input.config.dumpBin : undefined,
      resourceDir: input.config.resourceDir,
    });
    const entryName =
      input.entryName ?? buildBackupNames(target.database, new Date(startedAt)).entryName;

    let state: AttemptState = { includeMysqlOnly: !binary.isMariaDb, includeRoutines: true };
    let attempt = 0;

    for (;;) {
      attempt += 1;
      if (cancelled !== null) throw cancelled;

      let bytesSql = 0;
      let bytesZip = 0;
      let phase: BackupPhase = "dump";
      const report = () => input.onProgress?.({ phase, bytesSql, bytesZip });

      const sink = await input.sink.open({
        entryName,
        zipLevel: input.config.zipLevel,
        onZipBytes: (total) => {
          bytesZip = total;
          report();
        },
      });
      const dump = runDump(target, { binary, ...state });
      active = { kill: dump.kill, abort: sink.abort };

      try {
        if (cancelled !== null) throw cancelled;
        const counted = new PassThrough();
        dump.stdout.on("data", (chunk: Buffer) => {
          bytesSql += chunk.length;
          report();
        });
        dump.stdout.pipe(counted);
        sink.append(counted);

        const { warnings } = await Promise.race([dump.done, sink.failed]);
        phase = "upload";
        report();
        const written = await sink.finish();
        return {
          busy: false,
          sizeBytes: written.bytesZip,
          rawBytes: bytesSql,
          sha256: written.sha256,
          durationMs: Date.now() - startedAt,
          warnings,
          database: target.database,
          dumpBinary: binary,
          ...(written.location === undefined ? {} : { location: written.location }),
        };
      } catch (failure) {
        dump.kill();
        await sink.abort().catch(() => {});
        if (cancelled !== null) throw cancelled;
        const plan = planRetry(errorMessage(failure), state, attempt);
        if (plan === null) throw failure;
        state = plan.state;
        if (!plan.consumesAttempt) attempt -= 1;
        if (plan.delayMs > 0) await delay(plan.delayMs);
      } finally {
        active = null;
      }
    }
  } finally {
    clearTimeout(deadline);
    input.signal?.removeEventListener("abort", onAbort);
    cancelActive = null;
    running = false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
