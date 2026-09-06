export const RESOURCE_VERSION = "1.0.0";
export const DEFAULT_API_BASE = "https://dashboard.qbox.re";
export const MIN_POLL_SECONDS = 60;
export const DEFAULT_POLL_SECONDS = 300;
export const DEFAULT_INTERVAL_HOURS = 1;
export const DEFAULT_LOCAL_KEEP = 7;

export type ConfigSource = (name: string, fallback: string) => string;
export type BackupMode = "local" | "upload";

export type Config = {
  connectionString: string;
  token: string;
  apiBase: string;
  localDir: string;
  resourceDir: string;
  keepLocal: boolean;
  localKeep: number;
  pollSeconds: number;
  intervalHours: number;
  intervalClamped: boolean;
  dumpBin: string;
  zipLevel: number;
  timeoutMinutes: number;
  mode: BackupMode;
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
    mode: token.length > 0 ? "upload" : "local",
  };
}

const URI_PASSWORD = /^([a-z][a-z0-9+.-]*:\/\/[^/@]*?:)[^/]*(@[^/@]*)/i;
const KEY_VALUE_PASSWORD = /(\b(?:password|pwd)\s*=\s*)([^;]*)/gi;

export function redactConnectionString(value: string): string {
  if (value.length === 0) return "";
  const redactedUri = value.replace(URI_PASSWORD, "$1***$2");
  if (redactedUri !== value) return redactedUri;
  return value.replace(KEY_VALUE_PASSWORD, "$1***");
}

function toInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
