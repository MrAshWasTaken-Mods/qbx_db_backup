export type ConnectionTarget = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
};

type Field = "host" | "port" | "user" | "password" | "database" | "ssl";

const KEY_ALIASES: Record<string, Field> = {
  user: "user",
  userid: "user",
  uid: "user",
  username: "user",
  password: "password",
  pwd: "password",
  host: "host",
  server: "host",
  "data source": "host",
  hostname: "host",
  port: "port",
  database: "database",
  "initial catalog": "database",
  dbname: "database",
  ssl: "ssl",
};

const TRUTHY = new Set(["true", "1", "yes", "y", "on", "require", "required"]);
const URI_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const DEFAULT_PORT = 3306;

export function parseConnectionString(raw: string): ConnectionTarget {
  const value = raw.trim();
  if (value.length === 0) {
    throw new Error(
      "Connection string is empty: set mysql_connection_string or qbx_db_backup_connection_string",
    );
  }
  return URI_PATTERN.test(value) ? parseUri(value) : parseKeyValue(value);
}

export function describeTarget(target: ConnectionTarget): string {
  return `${target.user}@${target.host}:${target.port}/${target.database}`;
}

function parseUri(value: string): ConnectionTarget {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Connection string is not a valid mysql:// URI");
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "mysql" && scheme !== "mariadb") {
    throw new Error(
      `Connection string scheme "${scheme}" is not supported: expected mysql:// or mariadb://`,
    );
  }
  const ssl = url.searchParams.get("ssl");
  return finalize({
    host: url.hostname,
    port: url.port,
    user: decode(url.username),
    password: decode(url.password),
    database: decode(url.pathname.replace(/^\//, "")),
    ssl: ssl === null ? "" : ssl,
  });
}

function parseKeyValue(value: string): ConnectionTarget {
  const fields: Partial<Record<Field, string>> = {};
  for (const segment of value.split(";")) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    const field = KEY_ALIASES[trimmed.slice(0, separator).trim().toLowerCase()];
    if (field === undefined) continue;
    fields[field] = unquote(trimmed.slice(separator + 1).trim());
  }
  return finalize({
    host: fields.host ?? "",
    port: fields.port ?? "",
    user: fields.user ?? "",
    password: fields.password ?? "",
    database: fields.database ?? "",
    ssl: fields.ssl ?? "",
  });
}

function finalize(raw: Record<Field, string>): ConnectionTarget {
  if (raw.host.length === 0) throw new Error("Connection string is missing the database host");
  if (raw.user.length === 0) throw new Error("Connection string is missing the database user");
  if (raw.database.length === 0) {
    throw new Error("Connection string is missing the database name");
  }
  const port = Number.parseInt(raw.port, 10);
  return {
    host: raw.host,
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT,
    user: raw.user,
    password: raw.password,
    database: raw.database,
    ssl: TRUTHY.has(raw.ssl.toLowerCase()),
  };
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function unquote(value: string): string {
  const quote = value.charAt(0);
  if (value.length >= 2 && (quote === "'" || quote === '"') && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  return value;
}
