import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  HOUR_MS,
  isOwnBackupFile,
  nextRunAt,
  pruneLocalBackups,
  readLastRunAt,
  STARTUP_GRACE_MS,
  STATE_FILE_NAME,
  selectPrunableBackups,
  writeLastRunAt,
} from "./schedule";

const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "qbx-schedule-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("nextRunAt", () => {
  it("keeps a due time that is still in the future", () => {
    expect(nextRunAt(NOW - HOUR_MS, 24, NOW)).toBe(NOW - HOUR_MS + 24 * HOUR_MS);
  });

  it("uses the startup grace period when the last run is unknown", () => {
    expect(nextRunAt(null, 24, NOW)).toBe(NOW + STARTUP_GRACE_MS);
  });

  it("uses the startup grace period when the interval already elapsed", () => {
    expect(nextRunAt(NOW - 48 * HOUR_MS, 24, NOW)).toBe(NOW + STARTUP_GRACE_MS);
  });

  it("uses the startup grace period when the run is due exactly now", () => {
    expect(nextRunAt(NOW - HOUR_MS, 1, NOW)).toBe(NOW + STARTUP_GRACE_MS);
  });

  it("honours an hourly interval", () => {
    expect(nextRunAt(NOW, 1, NOW)).toBe(NOW + HOUR_MS);
  });
});

describe("isOwnBackupFile", () => {
  it.each(["qbox-2026-09-06_13-27-36Z.zip", "qbox_5f9c13-2026-01-01_00-00-00Z.zip"])(
    "recognises %s",
    (name) => {
      expect(isOwnBackupFile(name)).toBe(true);
    },
  );

  it.each([
    "qbox-2026-09-06_13-27-36Z.zip.part",
    "qbox-2026-09-06_13-27-36Z.sql",
    "holiday-photos.zip",
    "2026-09-06.zip",
    ".state.json",
    "qbox-2026-09-06.zip",
  ])("ignores %s", (name) => {
    expect(isOwnBackupFile(name)).toBe(false);
  });
});

describe("selectPrunableBackups", () => {
  const names = [
    "qbox-2026-09-03_01-00-00Z.zip",
    "qbox-2026-09-01_01-00-00Z.zip",
    "qbox-2026-09-04_01-00-00Z.zip",
    "qbox-2026-09-02_01-00-00Z.zip",
  ];

  it("selects the oldest zips beyond the keep count", () => {
    expect(selectPrunableBackups(names, 2)).toEqual([
      "qbox-2026-09-01_01-00-00Z.zip",
      "qbox-2026-09-02_01-00-00Z.zip",
    ]);
  });

  it("selects nothing while the folder is under the keep count", () => {
    expect(selectPrunableBackups(names, 4)).toEqual([]);
    expect(selectPrunableBackups(names, 9)).toEqual([]);
  });

  it("never selects files the resource did not create", () => {
    const mixed = [...names, "server-config.zip", "qbox-2026-08-01_01-00-00Z.zip.part"];
    expect(selectPrunableBackups(mixed, 1)).toEqual([
      "qbox-2026-09-01_01-00-00Z.zip",
      "qbox-2026-09-02_01-00-00Z.zip",
      "qbox-2026-09-03_01-00-00Z.zip",
    ]);
  });

  it("always keeps at least one backup", () => {
    expect(selectPrunableBackups(names, 0)).toEqual([
      "qbox-2026-09-01_01-00-00Z.zip",
      "qbox-2026-09-02_01-00-00Z.zip",
      "qbox-2026-09-03_01-00-00Z.zip",
    ]);
  });
});

describe("pruneLocalBackups", () => {
  it("deletes only the oldest own zips", async () => {
    await withTempDir(async (dir) => {
      const names = [
        "qbox-2026-09-01_01-00-00Z.zip",
        "qbox-2026-09-02_01-00-00Z.zip",
        "qbox-2026-09-03_01-00-00Z.zip",
        "keep-me.zip",
      ];
      for (const name of names) await writeFile(path.join(dir, name), "x");
      expect(await pruneLocalBackups(dir, 2)).toEqual(["qbox-2026-09-01_01-00-00Z.zip"]);
      expect(await pruneLocalBackups(dir, 2)).toEqual([]);
    });
  });

  it("tolerates a missing folder", async () => {
    expect(await pruneLocalBackups(path.join(tmpdir(), "qbx-missing-folder-xyz"), 3)).toEqual([]);
  });
});

describe("run state", () => {
  it("round-trips the last run timestamp", async () => {
    await withTempDir(async (dir) => {
      await writeLastRunAt(dir, NOW);
      expect(await readLastRunAt(dir)).toBe(NOW);
    });
  });

  it("returns null when the state file is missing or corrupt", async () => {
    await withTempDir(async (dir) => {
      expect(await readLastRunAt(dir)).toBeNull();
      await writeFile(path.join(dir, STATE_FILE_NAME), "{not json");
      expect(await readLastRunAt(dir)).toBeNull();
      await writeFile(path.join(dir, STATE_FILE_NAME), '{"lastRunAt":"soon"}');
      expect(await readLastRunAt(dir)).toBeNull();
    });
  });
});
