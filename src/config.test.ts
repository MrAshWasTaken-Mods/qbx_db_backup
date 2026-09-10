import { describe, expect, it } from "bun:test";
import {
  type ConfigSource,
  DEFAULT_INTERVAL_HOURS,
  DEFAULT_LOCAL_KEEP,
  DEFAULT_POLL_SECONDS,
  loadConfig,
  MIN_POLL_SECONDS,
  redactSecret,
} from "./config";

const defaults = { localDir: "/srv/backups", resourceDir: "/srv/resource" };

function configWith(convars: Record<string, string>) {
  const source: ConfigSource = (name, fallback) => convars[name] ?? fallback;
  return loadConfig(source, defaults);
}

describe("schedule convars", () => {
  it("defaults to a daily backup keeping seven zips", () => {
    const config = configWith({});
    expect(config.intervalHours).toBe(DEFAULT_INTERVAL_HOURS);
    expect(config.localKeep).toBe(DEFAULT_LOCAL_KEEP);
    expect(config.intervalClamped).toBe(false);
  });

  it("accepts a custom interval", () => {
    expect(configWith({ qbx_db_backup_interval_hours: "6" }).intervalHours).toBe(6);
  });

  it("treats 0 as disabled without warning about clamping", () => {
    const config = configWith({ qbx_db_backup_interval_hours: "0" });
    expect(config.intervalHours).toBe(0);
    expect(config.intervalClamped).toBe(false);
  });

  it("clamps an interval below one hour and flags it", () => {
    const config = configWith({ qbx_db_backup_interval_hours: "-4" });
    expect(config.intervalHours).toBe(1);
    expect(config.intervalClamped).toBe(true);
  });

  it("falls back to the default for a non-numeric interval", () => {
    expect(configWith({ qbx_db_backup_interval_hours: "soon" }).intervalHours).toBe(
      DEFAULT_INTERVAL_HOURS,
    );
  });

  it("keeps at least one local backup", () => {
    expect(configWith({ qbx_db_backup_local_keep: "0" }).localKeep).toBe(1);
    expect(configWith({ qbx_db_backup_local_keep: "-3" }).localKeep).toBe(1);
    expect(configWith({ qbx_db_backup_local_keep: "30" }).localKeep).toBe(30);
  });
});

describe("retention convars", () => {
  it("loads local max age and min free disk convars", () => {
    const config = configWith({
      qbx_db_backup_local_max_age_days: "14",
      qbx_db_backup_min_free_disk_mb: "5000",
    });
    expect(config.localMaxAgeDays).toBe(14);
    expect(config.minFreeDiskMb).toBe(5000);
  });
});

describe("S3 convars", () => {
  it("loads full S3 configuration", () => {
    const config = configWith({
      qbx_db_backup_s3_endpoint: "https://12345.r2.cloudflarestorage.com",
      qbx_db_backup_s3_bucket: "my-backups",
      qbx_db_backup_s3_key: "ACCESS123",
      qbx_db_backup_s3_secret: "SECRET456",
      qbx_db_backup_s3_prefix: "fivem/",
      qbx_db_backup_s3_keep: "30",
      qbx_db_backup_s3_max_age_days: "60",
    });

    expect(config.s3.endpoint).toBe("https://12345.r2.cloudflarestorage.com");
    expect(config.s3.bucket).toBe("my-backups");
    expect(config.s3.accessKeyId).toBe("ACCESS123");
    expect(config.s3.secretAccessKey).toBe("SECRET456");
    expect(config.s3.region).toBe("auto");
    expect(config.s3.forcePathStyle).toBe(true);
    expect(config.s3.prefix).toBe("fivem/");
    expect(config.s3.keepCount).toBe(30);
    expect(config.s3.maxAgeDays).toBe(60);
  });
});

describe("heartbeat convars", () => {
  it("defaults to a five minute heartbeat", () => {
    expect(configWith({}).pollSeconds).toBe(DEFAULT_POLL_SECONDS);
  });

  it("accepts a custom interval", () => {
    expect(configWith({ qbx_db_backup_poll_seconds: "900" }).pollSeconds).toBe(900);
  });

  it("raises an interval below the minimum", () => {
    expect(configWith({ qbx_db_backup_poll_seconds: "5" }).pollSeconds).toBe(MIN_POLL_SECONDS);
  });

  it("falls back to the default for a non-numeric interval", () => {
    expect(configWith({ qbx_db_backup_poll_seconds: "often" }).pollSeconds).toBe(
      DEFAULT_POLL_SECONDS,
    );
  });
});

describe("mode resolution", () => {
  it("stays local without token or s3", () => {
    expect(configWith({}).mode).toBe("local");
  });

  it("resolves to qbx when token is set", () => {
    expect(configWith({ qbx_db_backup_token: "tok" }).mode).toBe("qbx");
  });

  it("resolves to s3 when s3 credentials and bucket are configured", () => {
    const config = configWith({
      qbx_db_backup_s3_bucket: "my-bucket",
      qbx_db_backup_s3_access_key_id: "KEY",
      qbx_db_backup_s3_secret_access_key: "SECRET",
    });
    expect(config.mode).toBe("s3");
  });

  it("prioritizes qbx over s3 when both are configured", () => {
    const config = configWith({
      qbx_db_backup_token: "tok",
      qbx_db_backup_s3_bucket: "my-bucket",
      qbx_db_backup_s3_access_key_id: "KEY",
      qbx_db_backup_s3_secret_access_key: "SECRET",
    });
    expect(config.mode).toBe("qbx");
  });
});

describe("redactSecret", () => {
  it("redacts sensitive keys", () => {
    expect(redactSecret("")).toBe("");
    expect(redactSecret("12345")).toBe("***");
    expect(redactSecret("my-super-secret-key-12345")).toBe("my-***345");
  });
});
