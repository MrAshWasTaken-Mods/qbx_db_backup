import type { DiscordConfig } from "./discord/types";
import type { S3Config } from "./s3/types";

export const RESOURCE_VERSION = "1.1.0";
export const DEFAULT_API_BASE = "https://dashboard.qbox.re";
export const MIN_POLL_SECONDS = 60;
export const DEFAULT_POLL_SECONDS = 300;
export const DEFAULT_INTERVAL_HOURS = 1;
export const DEFAULT_LOCAL_KEEP = 3;

export type BackupMode = "qbx" | "s3" | "gdrive" | "discord" | "local";

export interface GDriveConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  folderId?: string;
  credentialsFile?: string;
  keepCount: number;
  maxAgeDays: number;
  keepLocal: boolean;
}

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
  gdrive: GDriveConfig;
  discord: DiscordConfig;
};

export type ConfigSource = (name: string, fallback: string) => string;

export type ConfigDefaults = {
  localDir: string;
  resourceDir: string;
};

export function loadConfig(source: ConfigSource, defaults: ConfigDefaults): Config {
  const shared = source("mysql_connection_string", "").trim();
  const override = source("qbx_db_backup_connection_string", "").trim();
  const token = (source("qbx_db_backup_token", "") || source("qbx_backup_token", "")).trim();
  const apiBase = source("qbx_db_backup_api_base", DEFAULT_API_BASE).trim();
  const localDir = (
    source("qbx_db_backup_local_dir", "") || source("qbx_backup_local_dir", "")
  ).trim();
  const interval = toInt(
    source(
      "qbx_db_backup_interval_hours",
      source("qbx_backup_interval_hours", String(DEFAULT_INTERVAL_HOURS)),
    ),
    DEFAULT_INTERVAL_HOURS,
  );

  // S3 convars
  const s3Endpoint = (
    source("qbx_db_backup_s3_endpoint", "") || source("qbx_backup_s3_endpoint", "")
  ).trim();
  const s3Bucket = (
    source("qbx_db_backup_s3_bucket", "") || source("qbx_backup_s3_bucket", "")
  ).trim();
  const s3Region = (
    source("qbx_db_backup_s3_region", "") ||
    source(
      "qbx_backup_s3_region",
      s3Endpoint.includes("r2.cloudflarestorage.com") ? "auto" : "us-east-1",
    )
  ).trim();
  const s3AccessKeyId = (
    source("qbx_db_backup_s3_access_key_id", "") ||
    source("qbx_backup_s3_access_key_id", "") ||
    source("qbx_db_backup_s3_key", "") ||
    source("qbx_backup_s3_key", "")
  ).trim();
  const s3SecretAccessKey = (
    source("qbx_db_backup_s3_secret_access_key", "") ||
    source("qbx_backup_s3_secret_access_key", "") ||
    source("qbx_db_backup_s3_secret", "") ||
    source("qbx_backup_s3_secret", "")
  ).trim();
  const s3PathStyleRaw = (
    source("qbx_db_backup_s3_force_path_style", "") || source("qbx_backup_s3_force_path_style", "")
  ).trim();
  const s3Prefix = (
    source("qbx_db_backup_s3_prefix", "") || source("qbx_backup_s3_prefix", "")
  ).trim();
  const s3Keep = Math.max(
    0,
    toInt(
      source(
        "qbx_db_backup_s3_keep",
        source(
          "qbx_backup_s3_keep",
          source(
            "qbx_backup_s3_retention_max_count",
            source("qbx_db_backup_s3_retention_max_count", "0"),
          ),
        ),
      ),
      0,
    ),
  );
  const s3MaxAgeDays = Math.max(
    0,
    toInt(
      source(
        "qbx_db_backup_s3_max_age_days",
        source(
          "qbx_backup_s3_max_age_days",
          source(
            "qbx_backup_s3_retention_max_age_days",
            source("qbx_db_backup_s3_retention_max_age_days", "0"),
          ),
        ),
      ),
      0,
    ),
  );

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

  // Google Drive convars
  const gdriveClientId = (
    source("qbx_db_backup_gdrive_client_id", "") || source("qbx_backup_gdrive_client_id", "")
  ).trim();
  const gdriveClientSecret = (
    source("qbx_db_backup_gdrive_client_secret", "") ||
    source("qbx_backup_gdrive_client_secret", "")
  ).trim();
  const gdriveRefreshToken = (
    source("qbx_db_backup_gdrive_refresh_token", "") ||
    source("qbx_backup_gdrive_refresh_token", "")
  ).trim();
  const gdriveFolderId = (
    source("qbx_db_backup_gdrive_folder_id", "") || source("qbx_backup_gdrive_folder_id", "")
  ).trim();
  const gdriveCredsFile = (
    source("qbx_db_backup_gdrive_credentials_file", "") ||
    source("qbx_backup_gdrive_credentials_file", "")
  ).trim();
  const gdriveKeep = Math.max(
    0,
    toInt(
      source(
        "qbx_db_backup_gdrive_keep",
        source(
          "qbx_backup_gdrive_keep",
          source(
            "qbx_backup_gdrive_retention_max_count",
            source("qbx_db_backup_gdrive_retention_max_count", "0"),
          ),
        ),
      ),
      0,
    ),
  );
  const gdriveMaxAgeDays = Math.max(
    0,
    toInt(
      source(
        "qbx_db_backup_gdrive_max_age_days",
        source(
          "qbx_backup_gdrive_max_age_days",
          source(
            "qbx_backup_gdrive_retention_max_age_days",
            source("qbx_db_backup_gdrive_retention_max_age_days", "0"),
          ),
        ),
      ),
      0,
    ),
  );
  const gdriveKeepLocalRaw = (
    source("qbx_db_backup_gdrive_keep_local", "") || source("qbx_backup_gdrive_keep_local", "0")
  )
    .trim()
    .toLowerCase();
  const gdriveKeepLocal = gdriveKeepLocalRaw === "1" || gdriveKeepLocalRaw === "true";

  const gdrive: GDriveConfig = {
    clientId: gdriveClientId,
    clientSecret: gdriveClientSecret,
    refreshToken: gdriveRefreshToken,
    folderId: gdriveFolderId.length > 0 ? gdriveFolderId : undefined,
    credentialsFile: gdriveCredsFile.length > 0 ? gdriveCredsFile : undefined,
    keepCount: gdriveKeep,
    maxAgeDays: gdriveMaxAgeDays,
    keepLocal: gdriveKeepLocal,
  };

  // Discord convars
  const discordWebhookUrl = (
    source("qbx_db_backup_discord_webhook_url", "") ||
    source("qbx_discord_webhook_url", "") ||
    source("qbx_db_backup_discord_webhook", "") ||
    source("qbx_discord_webhook", "")
  ).trim();
  const discordBotToken = (
    source("qbx_db_backup_discord_bot_token", "") ||
    source("qbx_discord_bot_token", "") ||
    source("qbx_db_backup_discord_token", "") ||
    source("qbx_discord_token", "")
  ).trim();
  const discordChannelId = (
    source("qbx_db_backup_discord_channel_id", "") ||
    source("qbx_discord_channel_id", "") ||
    source("qbx_db_backup_discord_channel", "") ||
    source("qbx_discord_channel", "")
  ).trim();
  const discordIsForumRaw = (
    source("qbx_db_backup_discord_is_forum", "") || source("qbx_discord_is_forum", "0")
  )
    .trim()
    .toLowerCase();
  const discordIsForum =
    discordIsForumRaw === "1" || discordIsForumRaw === "true" || discordIsForumRaw === "yes";
  const discordThreadTitle = (
    source("qbx_db_backup_discord_thread_title", "") ||
    source("qbx_discord_thread_title", "") ||
    source("qbx_db_backup_discord_thread_name", "") ||
    source("qbx_discord_thread_name", "")
  ).trim();
  const discordUsername = (
    source("qbx_db_backup_discord_username", "") || source("qbx_discord_username", "")
  ).trim();
  const discordAvatarUrl = (
    source("qbx_db_backup_discord_avatar_url", "") || source("qbx_discord_avatar_url", "")
  ).trim();
  const discordKeepLocalRaw = (
    source("qbx_db_backup_discord_keep_local", "") || source("qbx_discord_keep_local", "0")
  )
    .trim()
    .toLowerCase();
  const discordKeepLocal = discordKeepLocalRaw === "1" || discordKeepLocalRaw === "true";
  const discordMaxFileSizeMb = Math.max(
    1,
    toInt(
      source(
        "qbx_db_backup_discord_max_file_size_mb",
        source("qbx_discord_max_file_size_mb", "25"),
      ),
      25,
    ),
  );

  const discord: DiscordConfig = {
    webhookUrl: discordWebhookUrl.length > 0 ? discordWebhookUrl : undefined,
    botToken: discordBotToken.length > 0 ? discordBotToken : undefined,
    channelId: discordChannelId.length > 0 ? discordChannelId : undefined,
    isForum: discordIsForum,
    threadTitle: discordThreadTitle.length > 0 ? discordThreadTitle : undefined,
    username: discordUsername.length > 0 ? discordUsername : undefined,
    avatarUrl: discordAvatarUrl.length > 0 ? discordAvatarUrl : undefined,
    keepLocal: discordKeepLocal,
    maxFileSizeMb: discordMaxFileSizeMb,
  };

  const localMaxAgeDays = Math.max(
    0,
    toInt(source("qbx_db_backup_local_max_age_days", source("qbx_db_backup_max_age_days", "0")), 0),
  );
  const minFreeDiskMb = Math.max(0, toInt(source("qbx_db_backup_min_free_disk_mb", "0"), 0));

  const explicitDestination = (
    source("qbx_backup_destination", "") || source("qbx_db_backup_destination", "")
  )
    .trim()
    .toLowerCase();

  let mode: BackupMode = "local";
  if (explicitDestination === "qbx" && token.length > 0) {
    mode = "qbx";
  } else if (explicitDestination === "s3" && isS3Configured(s3)) {
    mode = "s3";
  } else if (explicitDestination === "gdrive" && isGDriveConfigured(gdrive)) {
    mode = "gdrive";
  } else if (explicitDestination === "discord" && isDiscordConfigured(discord)) {
    mode = "discord";
  } else if (token.length > 0) {
    mode = "qbx";
  } else if (isS3Configured(s3)) {
    mode = "s3";
  } else if (isGDriveConfigured(gdrive)) {
    mode = "gdrive";
  } else if (isDiscordConfigured(discord)) {
    mode = "discord";
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
    gdrive,
    discord,
  };
}

export function isS3Configured(s3: S3Config): boolean {
  return s3.bucket.length > 0 && s3.accessKeyId.length > 0 && s3.secretAccessKey.length > 0;
}

export function isGDriveConfigured(gdrive: GDriveConfig): boolean {
  return (
    (gdrive.clientId.length > 0 &&
      gdrive.clientSecret.length > 0 &&
      gdrive.refreshToken.length > 0) ||
    Boolean(gdrive.credentialsFile && gdrive.credentialsFile.length > 0)
  );
}

export function isDiscordConfigured(discord: DiscordConfig): boolean {
  return Boolean(
    (discord.webhookUrl && discord.webhookUrl.trim().length > 0) ||
      (discord.botToken &&
        discord.botToken.trim().length > 0 &&
        discord.channelId &&
        discord.channelId.trim().length > 0),
  );
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
