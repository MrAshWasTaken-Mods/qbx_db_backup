import path from "node:path";
import { AgentApi, type BackupJob, type HeartbeatResult, type JobTrigger } from "./api";
import {
  type BackupOutcome,
  buildBackupNames,
  cancelRunningBackup,
  isBackupRunning,
  runBackup,
} from "./backup";
import {
  type Config,
  isS3Configured,
  loadConfig,
  RESOURCE_VERSION,
  redactConnectionString,
  redactSecret,
} from "./config";
import { describeTarget, parseConnectionString } from "./connection-string";
import { type DumpBinary, detectDumpBinary } from "./dump";
import { error, errorMessage, info, warn } from "./log";
import { pruneLocalDirectory, pruneS3Bucket } from "./retention";
import { S3Client } from "./s3/client";
import { S3Sink } from "./s3/sink";
import { HOUR_MS, nextRunAt, readLastRunAt, writeLastRunAt } from "./schedule";
import { LocalFileSink, UploadSink } from "./zip-sink";

const PROGRESS_INTERVAL_MS = 10_000;
const MAX_TIMER_MS = 2_147_483_000;
const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"];

let config: Config;
let api: AgentApi | null = null;
let s3Client: S3Client | null = null;
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
  return `ok zip=${formatBytes(outcome.sizeBytes)} sql=${formatBytes(outcome.rawBytes)} in ${Math.round(outcome.durationMs / 1000)}s${outcome.location ? ` -> ${outcome.location}` : ""}${warnings}`;
}

function describeSchedule(): string {
  if (config.intervalHours <= 0) return "disabled";
  const next = scheduledAt === null ? "not scheduled" : formatLocalTime(scheduledAt);
  return `every ${config.intervalHours} h, next at ${next}`;
}

function describeRetention(): string {
  const parts: string[] = [`local_keep=${config.localKeep}`];
  if (config.localMaxAgeDays > 0) parts.push(`local_max_age=${config.localMaxAgeDays}d`);
  if (config.minFreeDiskMb > 0) parts.push(`min_free_disk=${config.minFreeDiskMb}MB`);
  if (isS3Configured(config.s3)) {
    if (config.s3.keepCount > 0) parts.push(`s3_keep=${config.s3.keepCount}`);
    if (config.s3.maxAgeDays > 0) parts.push(`s3_max_age=${config.s3.maxAgeDays}d`);
  }
  return parts.join(", ");
}

async function pruneLocal(): Promise<void> {
  try {
    const res = await pruneLocalDirectory(config.localDir, {
      keepCount: config.localKeep,
      maxAgeDays: config.localMaxAgeDays,
      minFreeDiskMb: config.minFreeDiskMb,
    });
    if (res.deletedFiles.length > 0) {
      info(
        `pruned ${res.deletedFiles.length} old local backup(s) (${formatBytes(res.freedBytes)} freed), ${res.remainingCount} remaining`,
      );
    }
  } catch (failure) {
    warn(`local retention pruning warning: ${errorMessage(failure)}`);
  }
}

async function pruneS3(): Promise<void> {
  if (s3Client === null) return;
  if (config.s3.keepCount <= 0 && config.s3.maxAgeDays <= 0) return;

  try {
    const res = await pruneS3Bucket(s3Client, {
      prefix: config.s3.prefix,
      keepCount: config.s3.keepCount,
      maxAgeDays: config.s3.maxAgeDays,
    });
    if (res.deletedKeys.length > 0) {
      info(
        `pruned ${res.deletedKeys.length} expired backup(s) from S3 bucket "${s3Client.bucket}"`,
      );
    }
    if (res.errors.length > 0) {
      warn(`S3 retention delete error: ${res.errors.map((e) => e.message).join("; ")}`);
    }
  } catch (failure) {
    warn(`S3 retention pruning warning: ${errorMessage(failure)}`);
  }
}

async function runLocalBackup(): Promise<BackupOutcome> {
  const target = parseConnectionString(config.connectionString);
  const names = buildBackupNames(target.database, new Date());
  const sink = new LocalFileSink(path.join(config.localDir, names.zipName));
  const outcome = await runBackup({ config, sink, entryName: names.entryName });
  lastOutcome = describeOutcome(outcome);
  info(lastOutcome);
  if (!outcome.busy) await pruneLocal();
  return outcome;
}

async function runS3Backup(): Promise<BackupOutcome> {
  if (s3Client === null) throw new Error("S3 client is not configured");
  const target = parseConnectionString(config.connectionString);
  const names = buildBackupNames(target.database, new Date());
  const key = config.s3.prefix
    ? `${config.s3.prefix.replace(/\/+$/, "")}/${names.zipName}`
    : names.zipName;

  const sink = new S3Sink({
    client: s3Client,
    s3Key: key,
    tmpDir: path.join(config.localDir, ".tmp"),
    keepLocalPath: config.keepLocal ? path.join(config.localDir, names.zipName) : undefined,
  });

  info(`starting S3 upload -> s3://${s3Client.bucket}/${key}`);
  const outcome = await runBackup({
    config,
    sink,
    entryName: names.entryName,
    timeoutMs: config.timeoutMinutes * 60_000,
  });

  lastOutcome = describeOutcome(outcome);
  info(lastOutcome);

  if (!outcome.busy) {
    await pruneS3();
    if (config.keepLocal) await pruneLocal();
  }
  return outcome;
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
  info(`starting Qbox backup job ${job.jobId} -> ${job.fileName}`);

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
    throw failure;
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

/** Robust priority & fallback pipeline */
async function executeBackupPipeline(trigger: JobTrigger): Promise<number | null> {
  if (isBackupRunning()) {
    info("a backup is already running");
    return null;
  }

  if (config.mode === "qbx") {
    try {
      return await requestJob(trigger);
    } catch (qbxFailure) {
      warn(
        `Qbox dashboard upload failed (${errorMessage(qbxFailure)}); activating fallback pipeline...`,
      );
      if (isS3Configured(config.s3)) {
        try {
          await runS3Backup();
          return null;
        } catch (s3Failure) {
          warn(
            `S3 upload fallback failed (${errorMessage(s3Failure)}); activating local storage fallback...`,
          );
          await runLocalBackup();
          return null;
        }
      }
      await runLocalBackup();
      return null;
    }
  }

  if (config.mode === "s3") {
    try {
      await runS3Backup();
      return null;
    } catch (s3Failure) {
      warn(`S3 upload failed (${errorMessage(s3Failure)}); activating local storage fallback...`);
      await runLocalBackup();
      return null;
    }
  }

  await runLocalBackup();
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
    const allowedAt = await executeBackupPipeline("scheduled");
    if (allowedAt !== null) nextAt = allowedAt;
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
  info(`retention: ${describeRetention()}`);

  if (isS3Configured(config.s3)) {
    const ep = config.s3.endpoint ?? `s3.${config.s3.region}.amazonaws.com`;
    info(
      `s3 storage: bucket="${config.s3.bucket}" endpoint="${ep}" region="${config.s3.region}" key="${config.s3.accessKeyId}" secret="${redactSecret(config.s3.secretAccessKey)}"`,
    );
  }

  if (lastHeartbeat !== null) {
    info(
      `dashboard plan ${lastHeartbeat.plan}: ${formatBytes(lastHeartbeat.usedBytes)} / ${formatBytes(lastHeartbeat.poolBytes)} used`,
    );
  }
  info(`last result: ${lastOutcome}`);
}

async function commandTest(): Promise<void> {
  try {
    const target = parseConnectionString(config.connectionString);
    info(`database: parsed ${describeTarget(target)} (ssl=${target.ssl})`);
    const binary = await detect();
    dumpBinary = binary;
    info(`dump binary: ${describeBinary(binary)}`);

    if (config.mode === "qbx" && api !== null) {
      info(`testing Qbox dashboard API at ${config.apiBase}...`);
      await pollOnce();
      info(`Qbox dashboard connected (plan=${lastHeartbeat?.plan ?? "unknown"})`);
    }

    if (isS3Configured(config.s3) && s3Client !== null) {
      info(
        `testing S3 storage at "${config.s3.endpoint ?? "AWS S3"}" (bucket: ${config.s3.bucket})...`,
      );
      await s3Client.testConnection();
      info(`S3 storage connected successfully (bucket "${config.s3.bucket}" is accessible)`);
    }
  } catch (failure) {
    error(errorMessage(failure));
  }
}

async function commandRun(): Promise<void> {
  try {
    await executeBackupPipeline("manual");
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

  if (isS3Configured(config.s3)) {
    s3Client = new S3Client(config.s3);
  }

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

  if (config.mode === "qbx") {
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
