import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildBackupNames, runBackup } from "../src/backup";
import { loadConfig } from "../src/config";
import { parseConnectionString } from "../src/connection-string";
import { LocalFileSink } from "../src/zip-sink";

const connection = process.env.QBX_DB_BACKUP_TEST_CONNECTION ?? "";
const resourceDir = path.resolve(import.meta.dirname, "..");
const expectsBundled =
  (process.platform === "win32" || process.platform === "linux") && process.arch === "x64";
const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

describe.skipIf(connection.length === 0)("runBackup against a real database", () => {
  it("writes a zip containing the sql entry", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qbx-db-backup-it-"));
    try {
      const config = loadConfig(
        (name, fallback) => (name === "mysql_connection_string" ? connection : fallback),
        { localDir: dir, resourceDir },
      );
      const target = parseConnectionString(connection);
      const names = buildBackupNames(target.database, new Date());
      const zipPath = path.join(dir, names.zipName);

      const outcome = await runBackup({
        config,
        sink: new LocalFileSink(zipPath),
        entryName: names.entryName,
      });

      expect(outcome.busy).toBe(false);
      if (outcome.busy) return;
      expect(Array.isArray(outcome.warnings)).toBe(true);
      expect(outcome.rawBytes).toBeGreaterThan(0);
      expect(outcome.sizeBytes).toBeGreaterThan(0);
      expect(outcome.sha256).toMatch(/^[0-9a-f]{64}$/);
      if (expectsBundled) expect(outcome.dumpBinary.source).toBe("bundled");

      const bytes = await readFile(zipPath);
      expect(bytes.length).toBe(outcome.sizeBytes);
      expect(bytes.subarray(0, 4)).toEqual(ZIP_LOCAL_HEADER);
      expect(bytes.includes(Buffer.from(names.entryName, "utf8"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
