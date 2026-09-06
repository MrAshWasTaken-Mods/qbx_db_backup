import path from "node:path";
import { AgentApi, type BackupJob, type HeartbeatResult, type JobTrigger } from "./api";
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
import { HOUR_MS, nextRunAt, pruneLocalBackups, readLastRunAt, writeLastRunAt } from "./schedule";
import { LocalFileSink, UploadSink } from "./zip-sink";

const PROGRESS_INTERVAL_MS = 10_000;
const MAX_TIMER_MS = 2_147_483_000;
const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"];

let config: Config;
let api: AgentApi | null = null;
let dumpBinary: DumpBinary | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let scheduleTimer: NodeJS.Timeout | null = null;
let scheduledAt: number | null = null;
let lastHeartbeat: HeartbeatResult | null = null;
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

function formatLocalTime(at: number): string {
  return new Date(at).toLocaleString();
}

function formatBytes(value: number): string {
  let size = Math.max(0, value);
  let unit = 0;
  while (size >= 1024 && unit < SIZE_UNITS.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? size : size.toFixed(1)} ${SIZE_UNITS[unit] ?? "B"}`;
}

function parseTimestamp(value: string | null): number | null {
  if (value === null || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
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

function describeSchedule(): string {
  if (config.intervalHours <= 0) return "disabled";
  const next = scheduledAt === null ? "not scheduled" : formatLocalTime(scheduledAt);
  return `every ${config.intervalHours} h, next at ${next}`;
}

async function pruneLocal(): Promise<void> {
  const removed = await pruneLocalBackups(config.localDir, config.localKeep).catch(
    (failure: unknown) => {
      warn(errorMessage(failure));
      return [] as string[];
    },
  );
  if (removed.length > 0) {
    info(`removed ${removed.length} old backup(s), keeping the newest ${config.localKeep}`);
  }
}

async function runLocalBackup(): Promise<void> {
  const target = parseConnectionString(config.connectionString);
  const names = buildBackupNames(target.database, new Date());
  const sink = new LocalFileSink(path.join(config.localDir, names.zipName));
  const outcome = await runBackup({ config, sink, entryName: names.entryName });
  lastOutcome = describeOutcome(outcome);
  info(lastOutcome);
  if (!outcome.busy) await pruneLocal();
}

async function runJob(job: BackupJob): Promise<void> {
  if (api === null) return;
  const client = api;
  const sink = new UploadSink({
    resolveUpload: async (upload) => {
      const ticket = await client.requestUpload(job.jobId, upload);
      return { url: ticket.uploadUrl, headers: ticket.uploadHeaders };
    },
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
    if (config.keepLocal) await pruneLocal();
    const result = await client.complete(job.jobId, {
      ok: true,
      sizeBytes: outcome.sizeBytes,
      rawBytes: outcome.rawBytes,
      sha256: outcome.sha256,
      durationMs: outcome.durationMs,
      warnings: outcome.warnings,
    });
    info(`job ${job.jobId}: ${result.status}`);
    if (result.status === "failed" && result.error) {
      lastOutcome = `failed: ${result.error}`;
      error(result.error);
    }
  } catch (failure) {
    lastOutcome = `failed: ${errorMessage(failure)}`;
    error(lastOutcome);
    await client
      .complete(job.jobId, { ok: false, error: errorMessage(failure) })
      .catch((reportFailure: unknown) => error(errorMessage(reportFailure)));
  }
}

async function requestJob(trigger: JobTrigger): Promise<number | null> {
  if (api === null) return null;
  const created = await api.createJob(trigger);
  if (created.status === "throttled") {
    const allowedAt = parseTimestamp(created.nextAllowedAt);
    info(
      `next backup allowed at ${allowedAt === null ? "a later time" : formatLocalTime(allowedAt)}`,
    );
    return allowedAt;
  }
  if (created.status === "busy") {
    info(`a backup job (${created.jobId}) is still in progress, skipping this run`);
    return null;
  }
  await runJob(created.job);
  return null;
}

function armSchedule(at: number): void {
  if (scheduleTimer !== null) clearTimeout(scheduleTimer);
  scheduledAt = at;
  const delay = Math.max(0, at - Date.now());
  scheduleTimer = setTimeout(
    delay > MAX_TIMER_MS ? () => armSchedule(at) : () => void runScheduled(),
    Math.min(delay, MAX_TIMER_MS),
  );
}

async function runScheduled(): Promise<void> {
  scheduleTimer = null;
  const startedAt = Date.now();
  let nextAt = startedAt + config.intervalHours * HOUR_MS;
  if (isBackupRunning()) {
    info("a backup is already running, skipping this scheduled run");
    armSchedule(nextAt);
    return;
  }
  await writeLastRunAt(config.localDir, startedAt).catch((failure: unknown) => {
    warn(errorMessage(failure));
  });
  try {
    if (config.mode === "local") {
      await runLocalBackup();
    } else {
      const allowedAt = await requestJob("scheduled");
      if (allowedAt !== null) nextAt = allowedAt;
    }
  } catch (failure) {
    lastOutcome = `failed: ${errorMessage(failure)}`;
    error(lastOutcome);
  }
  armSchedule(nextAt);
}

async function startSchedule(): Promise<void> {
  const lastRunAt = await readLastRunAt(config.localDir);
  armSchedule(nextRunAt(lastRunAt, config.intervalHours, Date.now()));
  info(`scheduled backups: ${describeSchedule()}`);
}

async function pollOnce(): Promise<void> {
  if (api === null) return;
  lastHeartbeat = await api.heartbeat({
    version: RESOURCE_VERSION,
    platform: `${process.platform}-${process.arch}`,
    dumpBinary,
    database: databaseName(),
    intervalHours: config.intervalHours,
  });
}

function printUsage(): void {
  info("usage: qbx_db_backup <run|status|test|version>");
}

function commandStatus(): void {
  info(`mode: ${config.mode}`);
  info(`target: ${targetLabel()}`);
  info(`state: ${isBackupRunning() ? "busy" : "idle"}`);
  info(`dump binary: ${dumpBinary ? describeBinary(dumpBinary) : "not found"}`);
  info(`schedule: ${describeSchedule()}`);
  if (lastHeartbeat !== null) {
    info(
      `plan ${lastHeartbeat.plan}: ${formatBytes(lastHeartbeat.usedBytes)} / ${formatBytes(lastHeartbeat.poolBytes)} used`,
    );
  }
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
    await requestJob("manual");
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
  if (config.intervalClamped) {
    warn("qbx_db_backup_interval_hours below 1 was raised to 1; use 0 to disable the schedule");
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

  if (config.intervalHours > 0) {
    void startSchedule().catch((failure: unknown) => error(errorMessage(failure)));
  } else {
    info("scheduled backups: disabled");
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
    if (scheduleTimer !== null) clearTimeout(scheduleTimer);
    scheduleTimer = null;
    scheduledAt = null;
    cancelRunningBackup("Resource stopped");
  });
}

try {
  start();
} catch (failure) {
  error(`startup failed: ${errorMessage(failure)}`);
}
