import path from "node:path";
import { buildBackupNames, runBackup } from "./backup";
import { type Config, type ConfigSource, loadConfig, RESOURCE_VERSION } from "./config";
import { describeTarget, parseConnectionString } from "./connection-string";
import { detectDumpBinary } from "./dump";
import { errorMessage } from "./log";
import { LocalFileSink } from "./zip-sink";

const FLAG_BY_CONVAR: Record<string, string> = {
  mysql_connection_string: "connection",
  qbx_db_backup_connection_string: "connection",
  qbx_db_backup_local_dir: "out",
  qbx_db_backup_dump_bin: "dump-bin",
  qbx_db_backup_zip_level: "zip-level",
  qbx_db_backup_timeout_minutes: "timeout-minutes",
};

const USAGE = `qbx_db_backup CLI v${RESOURCE_VERSION}

usage:
  node dist/cli.js run  --connection "<string>" [--out ./backups] [--dump-bin path] [--zip-level 6]
  node dist/cli.js test --connection "<string>" [--dump-bin path]

Flags fall back to environment variables: MYSQL_CONNECTION_STRING,
QBX_DB_BACKUP_CONNECTION_STRING, QBX_DB_BACKUP_LOCAL_DIR, QBX_DB_BACKUP_DUMP_BIN,
QBX_DB_BACKUP_ZIP_LEVEL, QBX_DB_BACKUP_TIMEOUT_MINUTES.`;

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
  const sink = new LocalFileSink(path.resolve(config.localDir, names.zipName));
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
  process.stdout.write(
    `${JSON.stringify({ target: describeTarget(target), ssl: target.ssl, dumpBinary: binary }, null, 2)}\n`,
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
