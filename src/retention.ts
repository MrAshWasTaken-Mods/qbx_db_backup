import { readdir, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import type { S3Client } from "./s3/client";

export const BACKUP_NAME_PATTERN = /^[A-Za-z0-9._-]+-(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})Z\.zip$/;

export type BackupEntry = {
  name: string;
  timestamp: number;
  sizeBytes?: number;
};

export type RetentionOptions = {
  maxCount?: number;
  maxAgeMs?: number;
  minFreeDiskBytes?: number;
  currentFreeDiskBytes?: number;
  now?: number;
  minKeep?: number;
};

export type LocalRetentionPolicy = {
  keepCount?: number;
  maxAgeDays?: number;
  minFreeDiskMb?: number;
};

export type S3RetentionPolicy = {
  prefix?: string;
  keepCount?: number;
  maxAgeDays?: number;
};

export type PruneLocalResult = {
  deletedFiles: string[];
  freedBytes: number;
  remainingCount: number;
};

export type PruneS3Result = {
  deletedKeys: string[];
  errors: { key: string; code: string; message: string }[];
};

export function isOwnBackupFile(name: string): boolean {
  const base = path.basename(name);
  return BACKUP_NAME_PATTERN.test(base);
}

export function parseBackupTimestamp(name: string): number | null {
  const base = path.basename(name);
  const match = BACKUP_NAME_PATTERN.exec(base);
  if (!match?.[1]) return null;

  const parts = match[1].split("_");
  const datePart = parts[0];
  const timePart = parts[1];
  if (!datePart || !timePart) return null;

  const [y, m, d] = datePart.split("-").map((v) => Number.parseInt(v, 10));
  const [hh, mm, ss] = timePart.split("-").map((v) => Number.parseInt(v, 10));
  if (
    y === undefined ||
    m === undefined ||
    d === undefined ||
    hh === undefined ||
    mm === undefined ||
    ss === undefined ||
    Number.isNaN(y) ||
    Number.isNaN(m) ||
    Number.isNaN(d) ||
    Number.isNaN(hh) ||
    Number.isNaN(mm) ||
    Number.isNaN(ss)
  ) {
    return null;
  }

  return Date.UTC(y, m - 1, d, hh, mm, ss);
}

export function selectPrunableEntries<T extends BackupEntry>(
  entries: T[],
  options: RetentionOptions,
): T[] {
  const now = options.now ?? Date.now();
  const minKeep = Math.max(1, options.minKeep ?? 1);

  // Filter valid backup entries and sort oldest first
  const valid = entries
    .filter((e) => isOwnBackupFile(e.name) && Number.isFinite(e.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);

  if (valid.length <= minKeep) {
    return [];
  }

  const prunableSet = new Set<T>();

  // 1. Amount-based retention: keep newest maxCount
  if (options.maxCount !== undefined && options.maxCount > 0) {
    const keep = Math.max(minKeep, options.maxCount);
    if (valid.length > keep) {
      const countPrunable = valid.slice(0, valid.length - keep);
      for (const item of countPrunable) {
        prunableSet.add(item);
      }
    }
  }

  // 2. Age-based retention: remove older than maxAgeMs
  if (options.maxAgeMs !== undefined && options.maxAgeMs > 0) {
    const cutoff = now - options.maxAgeMs;
    // We can only prune up to valid.length - minKeep items so at least minKeep items remain
    const maxAgeEligible = valid.slice(0, valid.length - minKeep);
    for (const item of maxAgeEligible) {
      if (item.timestamp < cutoff) {
        prunableSet.add(item);
      }
    }
  }

  // 3. Free disk space threshold retention
  if (
    options.minFreeDiskBytes !== undefined &&
    options.minFreeDiskBytes > 0 &&
    options.currentFreeDiskBytes !== undefined
  ) {
    let currentFree = options.currentFreeDiskBytes;
    // First account for bytes freed by already selected prunable items
    for (const item of prunableSet) {
      currentFree += item.sizeBytes ?? 0;
    }

    if (currentFree < options.minFreeDiskBytes) {
      // Iterate oldest first to free more space while respecting minKeep
      const spaceEligible = valid.slice(0, valid.length - minKeep);
      for (const item of spaceEligible) {
        if (currentFree >= options.minFreeDiskBytes) break;
        if (!prunableSet.has(item)) {
          prunableSet.add(item);
          currentFree += item.sizeBytes ?? 0;
        }
      }
    }
  }

  // Final check: guarantee at least minKeep items are NEVER pruned
  const neverPrune = new Set(valid.slice(valid.length - minKeep));
  return valid.filter((item) => prunableSet.has(item) && !neverPrune.has(item));
}

export async function getFreeDiskBytes(dir: string): Promise<number | null> {
  try {
    const stats = await statfs(dir);
    return Number(BigInt(stats.bavail) * BigInt(stats.bsize));
  } catch {
    return null;
  }
}

export async function pruneLocalDirectory(
  dir: string,
  policy: LocalRetentionPolicy,
): Promise<PruneLocalResult> {
  const filenames = await readdir(dir).catch((): string[] => []);
  const entries: BackupEntry[] = [];

  for (const name of filenames) {
    if (!isOwnBackupFile(name)) continue;
    const ts = parseBackupTimestamp(name);
    if (ts === null) continue;

    const fullPath = path.join(dir, name);
    let sizeBytes = 0;
    try {
      const fileStat = await stat(fullPath);
      sizeBytes = fileStat.size;
    } catch {
      // Ignored
    }

    entries.push({ name, timestamp: ts, sizeBytes });
  }

  let freeBytes: number | undefined;
  if (policy.minFreeDiskMb !== undefined && policy.minFreeDiskMb > 0) {
    const free = await getFreeDiskBytes(dir);
    if (free !== null) freeBytes = free;
  }

  const options: RetentionOptions = {
    maxCount: policy.keepCount,
    maxAgeMs:
      policy.maxAgeDays !== undefined && policy.maxAgeDays > 0
        ? policy.maxAgeDays * 86_400_000
        : undefined,
    minFreeDiskBytes:
      policy.minFreeDiskMb !== undefined && policy.minFreeDiskMb > 0
        ? policy.minFreeDiskMb * 1024 * 1024
        : undefined,
    currentFreeDiskBytes: freeBytes,
  };

  const prunable = selectPrunableEntries(entries, options);
  const deletedFiles: string[] = [];
  let freedBytes = 0;

  for (const item of prunable) {
    try {
      await rm(path.join(dir, item.name), { force: true });
      deletedFiles.push(item.name);
      freedBytes += item.sizeBytes ?? 0;
    } catch {
      // Ignored
    }
  }

  return {
    deletedFiles,
    freedBytes,
    remainingCount: entries.length - deletedFiles.length,
  };
}

export async function pruneS3Bucket(
  client: S3Client,
  policy: S3RetentionPolicy,
): Promise<PruneS3Result> {
  const prefix = policy.prefix ?? "";
  const listResult = await client.listObjectsV2({ prefix });

  const entries: (BackupEntry & { key: string })[] = [];
  for (const obj of listResult.objects) {
    const filename = path.basename(obj.key);
    if (!isOwnBackupFile(filename)) continue;
    const ts = parseBackupTimestamp(filename) ?? obj.lastModified.getTime();

    entries.push({
      name: filename,
      key: obj.key,
      timestamp: ts,
      sizeBytes: obj.sizeBytes,
    });
  }

  const options: RetentionOptions = {
    maxCount: policy.keepCount,
    maxAgeMs:
      policy.maxAgeDays !== undefined && policy.maxAgeDays > 0
        ? policy.maxAgeDays * 86_400_000
        : undefined,
  };

  const prunable = selectPrunableEntries(entries, options);
  if (prunable.length === 0) {
    return { deletedKeys: [], errors: [] };
  }

  const keysToDelete = prunable.map((p) => p.key);
  const deleteResult = await client.deleteObjects(keysToDelete);

  return deleteResult;
}
