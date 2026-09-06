import {
  type ChildProcessByStdio,
  type SpawnOptionsWithStdioTuple,
  type StdioNull,
  type StdioPipe,
  spawn,
} from "node:child_process";
import { once } from "node:events";
import { readdirSync } from "node:fs";
import { chmod } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import type { ConnectionTarget } from "./connection-string";

export type DumpTarget = ConnectionTarget;

export type DumpBinarySource = "explicit" | "bundled" | "path" | "windows-probe";

export type DumpBinary = {
  command: string;
  version: string;
  isMariaDb: boolean;
  source: DumpBinarySource;
};

export type AttemptState = {
  includeMysqlOnly: boolean;
  includeRoutines: boolean;
};

export type RetryPlan = {
  state: AttemptState;
  delayMs: number;
  consumesAttempt: boolean;
};

export type DumpAttempt = {
  stdout: Readable;
  done: Promise<{ warnings: string[] }>;
  kill: () => void;
};

export const MYSQLDUMP_BASE_ARGS = [
  "--single-transaction",
  "--quick",
  "--skip-lock-tables",
  "--routines",
  "--events",
  "--triggers",
  "--hex-blob",
  "--default-character-set=utf8mb4",
];
export const MYSQL_ONLY_ARGS = ["--column-statistics=0", "--set-gtid-purged=OFF"];
export const ROUTINE_ARGS = ["--routines", "--events"];
export const NO_ROUTINES_WARNING =
  "Dumped without routines/events: the database user lacks EVENT or routine privileges";
export const MISSING_BINARY_ERROR =
  "Failed to start dump command: no mysqldump/mariadb-dump binary available (set qbx_db_backup_dump_bin)";
export const SANDBOX_CHILD_PROCESS_ERROR =
  'Child processes are blocked by the FiveM sandbox: add add_unsafe_child_process_permission "qbx_db_backup" to server.cfg before ensure qbx_db_backup and restart the server';

const TRANSIENT_RETRY_ATTEMPTS = 3;
const STDERR_LIMIT = 64 * 1024;
const ROUTINE_PRIVILEGE_PATTERN =
  /access denied for user .* to database|show events|show function status|show procedure status|show create function|show create procedure|mysql\.proc|mysql\.routines/i;
const AUTH_FAILURE_PATTERN = /access denied for user[^\n]*\(using password:/i;

export function isTableDefinitionChangedError(stderr: string): boolean {
  const n = stderr.toLowerCase();
  return (
    n.includes("error 1412") || n.includes("(1412)") || n.includes("table definition has changed")
  );
}

export function isTransientMysqldumpError(stderr: string): boolean {
  const n = stderr.toLowerCase();
  return (
    n.includes("error 2013") ||
    n.includes("error 2006") ||
    n.includes("(2013)") ||
    n.includes("(2006)") ||
    n.includes("lost connection to mysql server") ||
    n.includes("lost connection to server") ||
    n.includes("mysql server has gone away") ||
    n.includes("econnreset") ||
    n.includes("broken pipe") ||
    isTableDefinitionChangedError(stderr)
  );
}

export function transientRetryDelayMs(stderr: string, attempt: number): number {
  return (isTableDefinitionChangedError(stderr) ? 30_000 : 750) * attempt;
}

export function hasUnsupportedMysqlSpecificArgError(stderr: string): boolean {
  const n = stderr.toLowerCase();
  return (
    n.includes("unknown variable") &&
    (n.includes("column-statistics") || n.includes("set-gtid-purged"))
  );
}

export function isSandboxChildProcessError(message: string): boolean {
  return /allow-child-process|child spawn not allowed|ERR_ACCESS_DENIED/i.test(message);
}

export function isAuthFailureError(stderr: string): boolean {
  const n = stderr.toLowerCase();
  return AUTH_FAILURE_PATTERN.test(stderr) || n.includes("error 1045") || n.includes("(1045)");
}

export function isRoutinePrivilegeError(stderr: string): boolean {
  return !isAuthFailureError(stderr) && ROUTINE_PRIVILEGE_PATTERN.test(stderr);
}

export function planRetry(stderr: string, state: AttemptState, attempt: number): RetryPlan | null {
  if (state.includeMysqlOnly && hasUnsupportedMysqlSpecificArgError(stderr)) {
    return {
      state: { ...state, includeMysqlOnly: false },
      delayMs: 0,
      consumesAttempt: false,
    };
  }
  if (state.includeRoutines && isRoutinePrivilegeError(stderr)) {
    return {
      state: { ...state, includeRoutines: false },
      delayMs: 0,
      consumesAttempt: false,
    };
  }
  if (attempt < TRANSIENT_RETRY_ATTEMPTS && isTransientMysqldumpError(stderr)) {
    return { state, delayMs: transientRetryDelayMs(stderr, attempt), consumesAttempt: true };
  }
  return null;
}

export function buildDumpArgs(
  target: DumpTarget,
  state: AttemptState,
  binary: Pick<DumpBinary, "isMariaDb">,
): string[] {
  const base = state.includeRoutines
    ? MYSQLDUMP_BASE_ARGS
    : MYSQLDUMP_BASE_ARGS.filter((arg) => !ROUTINE_ARGS.includes(arg));
  const ssl = target.ssl ? [binary.isMariaDb ? "--ssl" : "--ssl-mode=REQUIRED"] : [];
  return [
    `--host=${target.host}`,
    `--port=${target.port}`,
    `--user=${target.user}`,
    ...base,
    ...ssl,
    ...(state.includeMysqlOnly ? MYSQL_ONLY_ARGS : []),
    target.database,
  ];
}

export function bundledBinaryPath(
  resourceDir: string,
  platform: NodeJS.Platform,
  arch: string,
): string | null {
  if (platform === "win32" && arch === "x64") {
    return path.join(resourceDir, "bin", "win64", "mariadb-dump.exe");
  }
  if (platform === "linux" && arch === "x64") {
    return path.join(resourceDir, "bin", "linux-x64", "mariadb-dump");
  }
  return null;
}

export function candidateOrder(input: { explicitPath?: string; bundled: string | null }): string[] {
  const candidates: string[] = [];
  if (input.explicitPath !== undefined && input.explicitPath.length > 0) {
    candidates.push(input.explicitPath);
  }
  if (input.bundled !== null) candidates.push(input.bundled);
  candidates.push("mariadb-dump", "mysqldump");
  return candidates;
}

export type DetectDumpBinaryOptions = {
  explicitPath?: string;
  resourceDir: string;
};

let cachedBinary: { key: string; value: DumpBinary } | null = null;

export function resetDumpBinaryCache(): void {
  cachedBinary = null;
}

export async function detectDumpBinary(options: DetectDumpBinaryOptions): Promise<DumpBinary> {
  const explicitPath =
    options.explicitPath !== undefined && options.explicitPath.length > 0
      ? options.explicitPath
      : undefined;
  const key = `${explicitPath ?? ""}\u0000${options.resourceDir}`;
  if (cachedBinary !== null && cachedBinary.key === key) return cachedBinary.value;

  const bundled = bundledBinaryPath(options.resourceDir, process.platform, process.arch);
  const candidates = candidateOrder({ explicitPath, bundled });
  const explicitCount = explicitPath === undefined ? 0 : 1;

  for (let index = 0; index < candidates.length; index += 1) {
    const command = candidates[index];
    if (command === undefined) continue;
    const source: DumpBinarySource =
      index < explicitCount
        ? "explicit"
        : index === explicitCount && bundled !== null
          ? "bundled"
          : "path";
    if (source === "bundled") await makeExecutable(command);
    const version = await captureVersion(command);
    if (version === null) continue;
    return remember(key, command, version, source);
  }

  for (const command of windowsCandidates()) {
    const version = await captureVersion(command);
    if (version === null) continue;
    return remember(key, command, version, "windows-probe");
  }

  throw new Error(MISSING_BINARY_ERROR);
}

export function runDump(
  target: DumpTarget,
  options: { binary: DumpBinary } & AttemptState,
): DumpAttempt {
  const child = spawnChecked(
    options.binary.command,
    buildDumpArgs(target, options, options.binary),
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, MYSQL_PWD: target.password },
    },
  );

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
    if (stderr.length > STDERR_LIMIT) stderr = stderr.slice(-STDERR_LIMIT);
  });

  const done = (async () => {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (spawnError: Error) =>
        reject(new Error(`Failed to start dump command: ${spawnError.message}`)),
      );
    });
    const [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
    if (code !== 0) {
      throw new Error(
        stderr.trim() ||
          `${options.binary.command} exited with code ${code ?? "null"}${signal ? ` (signal ${signal})` : ""}`,
      );
    }
    return { warnings: options.includeRoutines ? [] : [NO_ROUTINES_WARNING] };
  })();

  return {
    stdout: child.stdout,
    done,
    kill: () => {
      child.kill("SIGKILL");
    },
  };
}

function remember(
  key: string,
  command: string,
  version: string,
  source: DumpBinarySource,
): DumpBinary {
  const value: DumpBinary = { command, version, isMariaDb: /mariadb/i.test(version), source };
  cachedBinary = { key, value };
  return value;
}

async function makeExecutable(target: string): Promise<void> {
  if (process.platform !== "linux") return;
  await chmod(target, 0o755).catch(() => undefined);
}

function spawnChecked(
  command: string,
  args: string[],
  options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>,
): ChildProcessByStdio<null, Readable, Readable> {
  try {
    return spawn(command, args, options);
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : String(failure);
    throw new Error(isSandboxChildProcessError(message) ? SANDBOX_CHILD_PROCESS_ERROR : message);
  }
}

function captureVersion(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawnChecked(command, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      out += String(chunk);
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? out.trim() : null));
  });
}

function windowsCandidates(): string[] {
  if (process.platform !== "win32") return [];
  const programFiles = "C:\\Program Files";
  const found: string[] = [];
  for (const entry of listDir(programFiles)) {
    if (/^MariaDB/i.test(entry)) {
      found.push(path.join(programFiles, entry, "bin", "mariadb-dump.exe"));
    }
  }
  const mysqlRoot = path.join(programFiles, "MySQL");
  for (const entry of listDir(mysqlRoot)) {
    if (/^MySQL Server/i.test(entry)) {
      found.push(path.join(mysqlRoot, entry, "bin", "mysqldump.exe"));
    }
  }
  found.push("C:\\xampp\\mysql\\bin\\mysqldump.exe");
  return found;
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
