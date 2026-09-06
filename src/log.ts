export function info(...parts: unknown[]): void {
  console.log(...parts);
}

export function warn(...parts: unknown[]): void {
  console.warn("WARNING:", ...parts);
}

export function error(...parts: unknown[]): void {
  console.error("ERROR:", ...parts);
}

export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
