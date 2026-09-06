import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const STARTUP_GRACE_MS = 60_000;
export const STATE_FILE_NAME = ".state.json";
export const HOUR_MS = 3_600_000;

const BACKUP_NAME_PATTERN = /^[A-Za-z0-9._-]+-(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})Z\.zip$/;

export function isOwnBackupFile(name: string): boolean {
  return BACKUP_NAME_PATTERN.test(name);
}

export function nextRunAt(lastRunAt: number | null, intervalHours: number, now: number): number {
  if (lastRunAt !== null) {
    const due = lastRunAt + intervalHours * HOUR_MS;
    if (due > now) return due;
  }
  return now + STARTUP_GRACE_MS;
}

export function selectPrunableBackups(names: string[], keep: number): string[] {
  const owned = names.filter(isOwnBackupFile).sort(compareByStamp);
  return owned.slice(0, Math.max(0, owned.length - Math.max(1, keep)));
}

export async function readLastRunAt(dir: string): Promise<number | null> {
  try {
    const raw = await readFile(path.join(dir, STATE_FILE_NAME), "utf8");
    const parsed = JSON.parse(raw) as { lastRunAt?: unknown };
    const value = parsed?.lastRunAt;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export async function writeLastRunAt(dir: string, lastRunAt: number): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, STATE_FILE_NAME), `${JSON.stringify({ lastRunAt })}\n`, "utf8");
}

export async function pruneLocalBackups(dir: string, keep: number): Promise<string[]> {
  const names = await readdir(dir).catch((): string[] => []);
  const prunable = selectPrunableBackups(names, keep);
  for (const name of prunable) {
    await rm(path.join(dir, name), { force: true });
  }
  return prunable;
}

function stampOf(name: string): string {
  return BACKUP_NAME_PATTERN.exec(name)?.[1] ?? "";
}

function compareByStamp(left: string, right: string): number {
  const a = stampOf(left);
  const b = stampOf(right);
  if (a !== b) return a < b ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
