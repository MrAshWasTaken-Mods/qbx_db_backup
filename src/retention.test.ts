import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type BackupEntry,
  isOwnBackupFile,
  parseBackupTimestamp,
  pruneLocalDirectory,
  selectPrunableEntries,
} from "./retention";

describe("Retention Engine", () => {
  it("recognizes own backup filenames and extracts UTC timestamps", () => {
    expect(isOwnBackupFile("qbox-2026-09-06_13-27-36Z.zip")).toBe(true);
    expect(isOwnBackupFile("qbox_db-2026-01-01_00-00-00Z.zip")).toBe(true);
    expect(isOwnBackupFile("holiday.zip")).toBe(false);

    const ts = parseBackupTimestamp("qbox-2026-09-06_13-27-36Z.zip");
    expect(ts).toBe(Date.UTC(2026, 8, 6, 13, 27, 36));
  });

  const baseTime = Date.UTC(2026, 8, 10, 12, 0, 0);
  const oneDay = 86_400_000;

  const sampleEntries: BackupEntry[] = [
    { name: "db-2026-09-01_12-00-00Z.zip", timestamp: baseTime - 9 * oneDay, sizeBytes: 100 },
    { name: "db-2026-09-03_12-00-00Z.zip", timestamp: baseTime - 7 * oneDay, sizeBytes: 100 },
    { name: "db-2026-09-05_12-00-00Z.zip", timestamp: baseTime - 5 * oneDay, sizeBytes: 100 },
    { name: "db-2026-09-07_12-00-00Z.zip", timestamp: baseTime - 3 * oneDay, sizeBytes: 100 },
    { name: "db-2026-09-09_12-00-00Z.zip", timestamp: baseTime - 1 * oneDay, sizeBytes: 100 },
  ];

  it("selects prunable entries based on maxCount (amount-based)", () => {
    // Keep 3 newest -> prune the 2 oldest
    const prunable = selectPrunableEntries(sampleEntries, { maxCount: 3, now: baseTime });
    expect(prunable.map((p) => p.name)).toEqual([
      "db-2026-09-01_12-00-00Z.zip",
      "db-2026-09-03_12-00-00Z.zip",
    ]);
  });

  it("selects prunable entries based on maxAgeMs (age-based)", () => {
    // Prune backups older than 6 days (i.e. older than Sept 4)
    const prunable = selectPrunableEntries(sampleEntries, {
      maxAgeMs: 6 * oneDay,
      now: baseTime,
    });
    expect(prunable.map((p) => p.name)).toEqual([
      "db-2026-09-01_12-00-00Z.zip",
      "db-2026-09-03_12-00-00Z.zip",
    ]);
  });

  it("selects prunable entries based on free disk space threshold", () => {
    // Free space is 50 bytes, threshold is 250 bytes -> need to free 200 bytes (2 files)
    const prunable = selectPrunableEntries(sampleEntries, {
      minFreeDiskBytes: 250,
      currentFreeDiskBytes: 50,
      now: baseTime,
    });
    expect(prunable.map((p) => p.name)).toEqual([
      "db-2026-09-01_12-00-00Z.zip",
      "db-2026-09-03_12-00-00Z.zip",
    ]);
  });

  it("always keeps at least 1 newest backup even if age or disk threshold would delete all", () => {
    const singleEntry: BackupEntry[] = [
      { name: "db-2026-09-01_12-00-00Z.zip", timestamp: baseTime - 100 * oneDay, sizeBytes: 100 },
    ];
    const prunable = selectPrunableEntries(singleEntry, {
      maxAgeMs: 1 * oneDay,
      minFreeDiskBytes: 1000,
      currentFreeDiskBytes: 10,
      now: baseTime,
    });
    expect(prunable).toEqual([]);
  });

  it("prunes local directory and calculates freed bytes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qbx-retention-test-"));
    try {
      const names = [
        "db-2026-09-01_12-00-00Z.zip",
        "db-2026-09-03_12-00-00Z.zip",
        "db-2026-09-05_12-00-00Z.zip",
      ];
      for (const name of names) {
        await writeFile(path.join(dir, name), "content123");
      }

      const result = await pruneLocalDirectory(dir, { keepCount: 2 });
      expect(result.deletedFiles).toEqual(["db-2026-09-01_12-00-00Z.zip"]);
      expect(result.remainingCount).toBe(2);
      expect(result.freedBytes).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
