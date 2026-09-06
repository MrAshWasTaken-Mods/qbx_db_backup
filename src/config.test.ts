import { describe, expect, it } from "vitest";
import {
  type ConfigSource,
  DEFAULT_INTERVAL_HOURS,
  DEFAULT_LOCAL_KEEP,
  DEFAULT_POLL_SECONDS,
  loadConfig,
  MIN_POLL_SECONDS,
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

describe("mode", () => {
  it("stays local without a token", () => {
    expect(configWith({}).mode).toBe("local");
  });

  it("switches to upload with a token", () => {
    expect(configWith({ qbx_db_backup_token: "tok" }).mode).toBe("upload");
  });
});
