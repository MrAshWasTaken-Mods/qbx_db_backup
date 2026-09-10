import type { S3Config } from "./s3/types";

export const RESOURCE_VERSION = "1.0.0";
export const DEFAULT_API_BASE = "https://dashboard.qbox.re";
export const MIN_POLL_SECONDS = 60;
export const DEFAULT_POLL_SECONDS = 300;
export const DEFAULT_INTERVAL_HOURS = 1;
export const DEFAULT_LOCAL_KEEP = 7;

export type ConfigSource = (name: string, fallback: string) => string;
export type BackupMode = "local" | "qbx" | "s3";

export type Config = {
  connectionString: string;
  token: string;
  apiBase: string;
  localDir: string;
  resourceDir: string;
  keepLocal: boolean;
  localKeep: number;
  localMaxAgeDays: number;
  minFreeDiskMb: number;
  pollSeconds: number;
  intervalHours: number;
  intervalClamped: boolean;
  dumpBin: string;
  zipLevel: number;
  timeoutMinutes: number;
  mode: BackupMode;
  s3: S3Config;
};

export function loadConfig(
  source: ConfigSource,
  defaults: { localDir: string; resourceDir: string },
): Config {
  const shared = source("mysql_connection_string", "").trim();
  const override = source("qbx_db_backup_connection_string", "").trim();
  const token = source("qbx_db_backup_token", "").trim();
  const apiBase = source("qbx_db_backup_api", DEFAULT_API_BASE).trim();
  const localDir = source("qbx_db_backup_local_dir", defaults.localDir).trim();
  const interval = toInt(
    source("qbx_db_backup_interval_hours", String(DEFAULT_INTERVAL_HOURS)),
    DEFAULT_INTERVAL_HOURS,
  );

  // S3 convars
  const s3Endpoint = source("qbx_db_backup_s3_endpoint", "").trim();
  const s3Bucket = source("qbx_db_backup_s3_bucket", "").trim();
  const s3Region = source(
    "qbx_db_backup_s3_region",
    s3Endpoint.includes("r2.cloudflarestorage.com") ? "auto" : "us-east-1",
  ).trim();
  const s3AccessKeyId = (
    source("qbx_db_backup_s3_access_key_id", "") || source("qbx_db_backup_s3_key", "")
  ).trim();
  const s3SecretAccessKey = (
    source("qbx_db_backup_s3_secret_access_key", "") || source("qbx_db_backup_s3_secret", "")
  ).trim();
  const s3PathStyleRaw = source("qbx_db_backup_s3_force_path_style", "").trim();
  const s3Prefix = source("qbx_db_backup_s3_prefix", "").trim();
  const s3Keep = Math.max(0, toInt(source("qbx_db_backup_s3_keep", "0"), 0));
  const s3MaxAgeDays = Math.max(0, toInt(source("qbx_db_backup_s3_max_age_days", "0"), 0));

  const forcePathStyle =
    s3PathStyleRaw === "1" ? true : s3PathStyleRaw === "0" ? false : s3Endpoint.length > 0;

  const s3: S3Config = {
    endpoint: s3Endpoint.length > 0 ? s3Endpoint : undefined,
    bucket: s3Bucket,
    region: s3Region.length > 0 ? s3Region : "us-east-1",
    accessKeyId: s3AccessKeyId,
    secretAccessKey: s3SecretAccessKey,
    forcePathStyle,
    prefix: s3Prefix,
    keepCount: s3Keep,
    maxAgeDays: s3MaxAgeDays,
  };

  const localMaxAgeDays = Math.max(
    0,
    toInt(source("qbx_db_backup_local_max_age_days", source("qbx_db_backup_max_age_days", "0")), 0),
  );
  const minFreeDiskMb = Math.max(0, toInt(source("qbx_db_backup_min_free_disk_mb", "0"), 0));

  let mode: BackupMode = "local";
  if (token.length > 0) {
    mode = "qbx";
  } else if (isS3Configured(s3)) {
    mode = "s3";
  }

  return {
    connectionString: override.length > 0 ? override : shared,
    token,
    apiBase: (apiBase.length > 0 ? apiBase : DEFAULT_API_BASE).replace(/\/+$/, ""),
    localDir: localDir.length > 0 ? localDir : defaults.localDir,
    resourceDir: defaults.resourceDir,
    keepLocal: source("qbx_db_backup_keep_local", "0").trim() === "1",
    localKeep: Math.max(
      1,
      toInt(source("qbx_db_backup_local_keep", String(DEFAULT_LOCAL_KEEP)), DEFAULT_LOCAL_KEEP),
    ),
    localMaxAgeDays,
    minFreeDiskMb,
    pollSeconds: Math.max(
      MIN_POLL_SECONDS,
      toInt(
        source("qbx_db_backup_poll_seconds", String(DEFAULT_POLL_SECONDS)),
        DEFAULT_POLL_SECONDS,
      ),
    ),
    intervalHours: interval === 0 ? 0 : Math.max(1, interval),
    intervalClamped: interval !== 0 && interval < 1,
    dumpBin: source("qbx_db_backup_dump_bin", "").trim(),
    zipLevel: clamp(toInt(source("qbx_db_backup_zip_level", "6"), 6), 1, 9),
    timeoutMinutes: Math.max(1, toInt(source("qbx_db_backup_timeout_minutes", "120"), 120)),
    mode,
    s3,
  };
}

export function isS3Configured(s3: S3Config): boolean {
  return s3.bucket.length > 0 && s3.accessKeyId.length > 0 && s3.secretAccessKey.length > 0;
}

const URI_PASSWORD = /^([a-z][a-z0-9+.-]*:\/\/[^/@]*?:)[^/]*(@[^/@]*)/i;
const KEY_VALUE_PASSWORD = /(\b(?:password|pwd)\s*=\s*)([^;]*)/gi;

export function redactConnectionString(value: string): string {
  if (value.length === 0) return "";
  const redactedUri = value.replace(URI_PASSWORD, "$1***$2");
  if (redactedUri !== value) return redactedUri;
  return value.replace(KEY_VALUE_PASSWORD, "$1***");
}

export function redactSecret(secret: string): string {
  if (secret.length === 0) return "";
  if (secret.length <= 6) return "***";
  return `${secret.slice(0, 3)}***${secret.slice(-3)}`;
}

function toInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
