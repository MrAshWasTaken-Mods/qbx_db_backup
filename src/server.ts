import path from "node:path";
import { AgentApi, type BackupJob } from "./api";
import {
  type BackupOutcome,
  buildBackupNames,
  cancelRunningBackup,
  isBackupRunning,
  runBackup,
} from "./backup";
import { type Config, loadConfig, RESOURCE_VERSION, redactConnectionString } from "./config";
import { describeTarget, parseConnectionString } from "./connection-string";
import { type DumpBinary, detectDumpBinary } from "./dump";
import { error, errorMessage, info, warn } from "./log";
import { LocalFileSink, UploadSink } from "./zip-sink";

const PROGRESS_INTERVAL_MS = 10_000;

let config: Config;
let api: AgentApi | null = null;
let dumpBinary: DumpBinary | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let lastOutcome = "no backup has run yet";

function resourceDirectory(): string {
  try {
    return GetResourcePath(GetCurrentResourceName());
  } catch {
    return process.cwd();
  }
}

function targetLabel(): string {
  try {
    return describeTarget(parseConnectionString(config.connectionString));
  } catch {
    return redactConnectionString(config.connectionString) || "<not configured>";
  }
}

function databaseName(): string {
  try {
    return parseConnectionString(config.connectionString).database;
  } catch {
    return "";
  }
}

function describeBinary(binary: DumpBinary): string {
  return `${binary.command} (${binary.version}) [${binary.source}]`;
}

function detect(): Promise<DumpBinary> {
  return detectDumpBinary({
    explicitPath: config.dumpBin.length > 0 ? config.dumpBin : undefined,
    resourceDir: config.resourceDir,
  });
}

async function refreshDumpBinary(): Promise<void> {
  try {
    dumpBinary = await detect();
    info(`dump binary: ${describeBinary(dumpBinary)}`);
  } catch (failure) {
    dumpBinary = null;
    warn(errorMessage(failure));
  }
}

function describeOutcome(outcome: BackupOutcome): string {
  if (outcome.busy) return "a backup is already running";
  const warnings = outcome.warnings.length > 0 ? ` warnings=${outcome.warnings.join("; ")}` : "";
  return `ok zip=${outcome.sizeBytes}B sql=${outcome.rawBytes}B in ${Math.round(outcome.durationMs / 1000)}s${outcome.location ? ` -> ${outcome.location}` : ""}${warnings}`;
}

async function runLocalBackup(): Promise<void> {
  const target = parseConnectionString(config.connectionString);
  const names = buildBackupNames(target.database, new Date());
  const sink = new LocalFileSink(path.join(config.localDir, names.zipName));
  const outcome = await runBackup({ config, sink, entryName: names.entryName });
  lastOutcome = describeOutcome(outcome);
  info(lastOutcome);
}

async function runJob(job: BackupJob): Promise<void> {
  if (api === null) return;
  const client = api;
  const sink = new UploadSink({
    url: job.uploadUrl,
    headers: job.uploadHeaders,
    maxBytes: job.maxBytes,
    tmpDir: path.join(config.localDir, ".tmp"),
    keepLocalPath: config.keepLocal ? path.join(config.localDir, job.fileName) : undefined,
  });
  let lastPost = 0;
  info(`starting backup job ${job.jobId} -> ${job.fileName}`);
  try {
    const outcome = await runBackup({
      config,
      sink,
      entryName: job.entryName,
      timeoutMs: Math.min(job.timeoutMs, config.timeoutMinutes * 60_000),
      onProgress: (progress) => {
        const now = Date.now();
        if (now - lastPost < PROGRESS_INTERVAL_MS) return;
        lastPost = now;
        void client.progress(job.jobId, progress).catch(() => {});
      },
    });
    lastOutcome = describeOutcome(outcome);
    info(lastOutcome);
    if (outcome.busy) return;
    await client.complete(job.jobId, {
      ok: true,
      sizeBytes: outcome.sizeBytes,
      rawBytes: outcome.rawBytes,
      sha256: outcome.sha256,
      durationMs: outcome.durationMs,
      warnings: outcome.warnings,
    });
  } catch (failure) {
    lastOutcome = `failed: ${errorMessage(failure)}`;
    error(lastOutcome);
    await client
      .complete(job.jobId, { ok: false, error: errorMessage(failure) })
      .catch((reportFailure: unknown) => error(errorMessage(reportFailure)));
  }
}

async function pollOnce(): Promise<void> {
  if (api === null) return;
  await api.heartbeat({
    version: RESOURCE_VERSION,
    platform: `${process.platform}-${process.arch}`,
    dumpBinary,
    database: databaseName(),
  });
  if (isBackupRunning()) return;
  const job = await api.next();
  if (job !== null) await runJob(job);
}

function printUsage(): void {
  info("usage: qbx_db_backup <run|status|test|version>");
}

function commandStatus(): void {
  info(`mode: ${config.mode}`);
  info(`target: ${targetLabel()}`);
  info(`state: ${isBackupRunning() ? "busy" : "idle"}`);
  info(`dump binary: ${dumpBinary ? describeBinary(dumpBinary) : "not found"}`);
  info(`last result: ${lastOutcome}`);
}

async function commandTest(): Promise<void> {
  try {
    const target = parseConnectionString(config.connectionString);
    info(`connection string parsed: ${describeTarget(target)} ssl=${target.ssl}`);
    const binary = await detect();
    dumpBinary = binary;
    info(`dump binary: ${describeBinary(binary)}`);
  } catch (failure) {
    error(errorMessage(failure));
  }
}

async function commandRun(): Promise<void> {
  try {
    if (isBackupRunning()) {
      info("a backup is already running");
      return;
    }
    if (config.mode === "local") {
      await runLocalBackup();
      return;
    }
    if (api === null) return;
    await runJob(await api.createJob());
  } catch (failure) {
    lastOutcome = `failed: ${errorMessage(failure)}`;
    error(lastOutcome);
  }
}

function start(): void {
  const resourceDir = resourceDirectory();
  config = loadConfig((name, fallback) => GetConvar(name, fallback), {
    localDir: path.join(resourceDir, "backups"),
    resourceDir,
  });
  info(
    `v${RESOURCE_VERSION} mode=${config.mode} target=${targetLabel()} local_dir=${config.localDir}`,
  );
  if (config.connectionString.length === 0) {
    warn("no connection string: set mysql_connection_string or qbx_db_backup_connection_string");
  }
  void refreshDumpBinary();

  if (config.mode === "upload") {
    api = new AgentApi({
      baseUrl: config.apiBase,
      token: config.token,
      version: RESOURCE_VERSION,
    });
    info(`polling ${config.apiBase} every ${config.pollSeconds}s`);
    const poll = () => {
      void pollOnce().catch((failure: unknown) => error(errorMessage(failure)));
    };
    setTimeout(poll, 5_000);
    pollTimer = setInterval(poll, config.pollSeconds * 1000);
  }

  RegisterCommand(
    "qbx_db_backup",
    (_source, args) => {
      switch ((args[0] ?? "").toLowerCase()) {
        case "run":
          void commandRun();
          break;
        case "status":
          commandStatus();
          break;
        case "test":
          void commandTest();
          break;
        case "version":
          info(`qbx_db_backup v${RESOURCE_VERSION}`);
          break;
        default:
          printUsage();
      }
    },
    true,
  );

  on("onResourceStop", (name: string) => {
    if (name !== GetCurrentResourceName()) return;
    if (pollTimer !== null) clearInterval(pollTimer);
    pollTimer = null;
    cancelRunningBackup("Resource stopped");
  });
}

try {
  start();
} catch (failure) {
  error(`startup failed: ${errorMessage(failure)}`);
}
