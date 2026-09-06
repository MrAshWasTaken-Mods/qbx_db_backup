const PREFIX = "[qbx_db_backup]";

export function info(...parts: unknown[]): void {
  console.log(PREFIX, ...parts);
}

export function warn(...parts: unknown[]): void {
  console.warn(PREFIX, "WARNING:", ...parts);
}

export function error(...parts: unknown[]): void {
  console.error(PREFIX, "ERROR:", ...parts);
}

export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
