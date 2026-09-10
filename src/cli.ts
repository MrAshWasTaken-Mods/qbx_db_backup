import path from "node:path";
import { buildBackupNames, runBackup } from "./backup";
import {
  type Config,
  type ConfigSource,
  isS3Configured,
  loadConfig,
  RESOURCE_VERSION,
} from "./config";
import { describeTarget, parseConnectionString } from "./connection-string";
import { detectDumpBinary } from "./dump";
import { errorMessage } from "./log";
import { S3Client } from "./s3/client";
import { S3Sink } from "./s3/sink";
import { LocalFileSink } from "./zip-sink";

const FLAG_BY_CONVAR: Record<string, string> = {
  mysql_connection_string: "connection",
  qbx_db_backup_connection_string: "connection",
  qbx_db_backup_local_dir: "out",
  qbx_db_backup_dump_bin: "dump-bin",
  qbx_db_backup_zip_level: "zip-level",
  qbx_db_backup_timeout_minutes: "timeout-minutes",
  qbx_db_backup_s3_endpoint: "s3-endpoint",
  qbx_db_backup_s3_bucket: "s3-bucket",
  qbx_db_backup_s3_region: "s3-region",
  qbx_db_backup_s3_access_key_id: "s3-key",
  qbx_db_backup_s3_key: "s3-key",
  qbx_db_backup_s3_secret_access_key: "s3-secret",
  qbx_db_backup_s3_secret: "s3-secret",
  qbx_db_backup_s3_prefix: "s3-prefix",
  qbx_db_backup_s3_force_path_style: "s3-path-style",
  qbx_db_backup_s3_keep: "s3-keep",
  qbx_db_backup_s3_max_age_days: "s3-max-age",
};

const USAGE = `qbx_db_backup CLI v${RESOURCE_VERSION}

usage:
  node dist/cli.js run  --connection "<string>" [--out ./backups] [--dump-bin path] [--zip-level 6]
  node dist/cli.js test --connection "<string>" [--dump-bin path] [--s3-bucket b --s3-key k --s3-secret s]

Flags fall back to environment variables: MYSQL_CONNECTION_STRING,
QBX_DB_BACKUP_CONNECTION_STRING, QBX_DB_BACKUP_LOCAL_DIR, QBX_DB_BACKUP_DUMP_BIN,
QBX_DB_BACKUP_ZIP_LEVEL, QBX_DB_BACKUP_TIMEOUT_MINUTES, QBX_DB_BACKUP_S3_BUCKET,
QBX_DB_BACKUP_S3_KEY, QBX_DB_BACKUP_S3_SECRET, QBX_DB_BACKUP_S3_ENDPOINT,
QBX_DB_BACKUP_S3_REGION.`;

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) continue;
    const inline = token.indexOf("=");
    if (inline > 0) {
      flags[token.slice(2, inline)] = token.slice(inline + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[token.slice(2)] = "1";
      continue;
    }
    flags[token.slice(2)] = next;
    index += 1;
  }
  return flags;
}

function buildConfig(flags: Record<string, string>): Config {
  const source: ConfigSource = (name, fallback) => {
    if (name === "qbx_db_backup_token") return "";
    const flagName = FLAG_BY_CONVAR[name];
    const fromFlag = flagName === undefined ? undefined : flags[flagName];
    if (fromFlag !== undefined) return fromFlag;
    return process.env[name.toUpperCase()] ?? fallback;
  };
  return loadConfig(source, {
    localDir: path.resolve("backups"),
    resourceDir: path.resolve(__dirname, ".."),
  });
}

async function commandRun(config: Config): Promise<number> {
  const target = parseConnectionString(config.connectionString);
  const names = buildBackupNames(target.database, new Date());

  let sink = new LocalFileSink(path.resolve(config.localDir, names.zipName));

  if (isS3Configured(config.s3)) {
    const s3Client = new S3Client(config.s3);
    const key = config.s3.prefix
      ? `${config.s3.prefix.replace(/\/+$/, "")}/${names.zipName}`
      : names.zipName;
    sink = new S3Sink({
      client: s3Client,
      s3Key: key,
      tmpDir: path.resolve(config.localDir, ".tmp"),
      keepLocalPath: config.keepLocal ? path.resolve(config.localDir, names.zipName) : undefined,
    }) as unknown as LocalFileSink;
  }

  const outcome = await runBackup({ config, sink, entryName: names.entryName });
  if (outcome.busy) {
    process.stderr.write("a backup is already running\n");
    return 1;
  }
  process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  return 0;
}

async function commandTest(config: Config): Promise<number> {
  const target = parseConnectionString(config.connectionString);
  const binary = await detectDumpBinary({
    explicitPath: config.dumpBin.length > 0 ? config.dumpBin : undefined,
    resourceDir: config.resourceDir,
  });

  let s3Status: unknown = null;
  if (isS3Configured(config.s3)) {
    try {
      const s3Client = new S3Client(config.s3);
      await s3Client.testConnection();
      s3Status = {
        ok: true,
        bucket: config.s3.bucket,
        endpoint: config.s3.endpoint ?? `s3.${config.s3.region}.amazonaws.com`,
      };
    } catch (s3Err) {
      s3Status = { ok: false, error: errorMessage(s3Err) };
    }
  }

  process.stdout.write(
    `${JSON.stringify({ target: describeTarget(target), ssl: target.ssl, dumpBinary: binary, s3: s3Status }, null, 2)}\n`,
  );
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? "";
  const config = buildConfig(parseFlags(argv.slice(1)));
  if (command === "run") return await commandRun(config);
  if (command === "test") return await commandTest(config);
  process.stdout.write(`${USAGE}\n`);
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((failure: unknown) => {
    process.stderr.write(`${errorMessage(failure)}\n`);
    process.exitCode = 1;
  });
