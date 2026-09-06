import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ConnectionTarget } from "./connection-string";
import {
  buildDumpArgs,
  bundledBinaryPath,
  candidateOrder,
  hasUnsupportedMysqlSpecificArgError,
  isAuthFailureError,
  isRoutinePrivilegeError,
  isSandboxChildProcessError,
  isTableDefinitionChangedError,
  isTransientMysqldumpError,
  planRetry,
  transientRetryDelayMs,
} from "./dump";

const target: ConnectionTarget = {
  host: "db.internal",
  port: 3307,
  user: "root",
  password: "sup3rs3cret",
  database: "fivem",
  ssl: false,
};
const mariadb = { isMariaDb: true };
const mysql8 = { isMariaDb: false };

describe("buildDumpArgs", () => {
  it("adds the MySQL-only flags for a non-MariaDB binary", () => {
    expect(
      buildDumpArgs(target, { includeMysqlOnly: true, includeRoutines: true }, mysql8),
    ).toEqual([
      "--host=db.internal",
      "--port=3307",
      "--user=root",
      "--single-transaction",
      "--quick",
      "--skip-lock-tables",
      "--routines",
      "--events",
      "--triggers",
      "--hex-blob",
      "--default-character-set=utf8mb4",
      "--column-statistics=0",
      "--set-gtid-purged=OFF",
      "fivem",
    ]);
  });

  it("drops the MySQL-only flags for MariaDB", () => {
    const args = buildDumpArgs(target, { includeMysqlOnly: false, includeRoutines: true }, mariadb);
    expect(args).not.toContain("--column-statistics=0");
    expect(args).not.toContain("--set-gtid-purged=OFF");
    expect(args).toContain("--single-transaction");
    expect(args.at(-1)).toBe("fivem");
  });

  it("adds --ssl for MariaDB and --ssl-mode=REQUIRED for MySQL when TLS is required", () => {
    const state = { includeMysqlOnly: false, includeRoutines: true };
    expect(buildDumpArgs({ ...target, ssl: true }, state, mariadb)).toContain("--ssl");
    const mysqlArgs = buildDumpArgs(
      { ...target, ssl: true },
      { ...state, includeMysqlOnly: true },
      mysql8,
    );
    expect(mysqlArgs).toContain("--ssl-mode=REQUIRED");
    expect(mysqlArgs).not.toContain("--ssl");
  });

  it("drops --routines and --events on the privilege fallback", () => {
    const args = buildDumpArgs(target, { includeMysqlOnly: true, includeRoutines: false }, mysql8);
    expect(args).not.toContain("--routines");
    expect(args).not.toContain("--events");
    expect(args).toContain("--triggers");
  });

  it("never puts the password in argv", () => {
    const args = buildDumpArgs(target, { includeMysqlOnly: true, includeRoutines: true }, mysql8);
    expect(args.join(" ")).not.toContain("sup3rs3cret");
  });
});

describe("bundledBinaryPath", () => {
  it("points at the win64 binary on Windows x64", () => {
    expect(bundledBinaryPath("C:\\fx\\resources\\qbx_db_backup", "win32", "x64")).toBe(
      path.join("C:\\fx\\resources\\qbx_db_backup", "bin", "win64", "mariadb-dump.exe"),
    );
  });

  it("points at the linux-x64 binary on Linux x64", () => {
    expect(bundledBinaryPath("/srv/fx/resources/qbx_db_backup", "linux", "x64")).toBe(
      path.join("/srv/fx/resources/qbx_db_backup", "bin", "linux-x64", "mariadb-dump"),
    );
  });

  it("has no bundled binary for linux arm64", () => {
    expect(bundledBinaryPath("/srv/fx", "linux", "arm64")).toBeNull();
  });

  it("has no bundled binary for macOS", () => {
    expect(bundledBinaryPath("/opt/fx", "darwin", "x64")).toBeNull();
    expect(bundledBinaryPath("/opt/fx", "darwin", "arm64")).toBeNull();
  });
});

describe("candidateOrder", () => {
  const bundled = path.join("/res", "bin", "linux-x64", "mariadb-dump");

  it("tries the explicit path first", () => {
    expect(candidateOrder({ explicitPath: "/usr/bin/mariadb-dump", bundled })).toEqual([
      "/usr/bin/mariadb-dump",
      bundled,
      "mariadb-dump",
      "mysqldump",
    ]);
  });

  it("tries the bundled binary before PATH", () => {
    expect(candidateOrder({ bundled })).toEqual([bundled, "mariadb-dump", "mysqldump"]);
  });

  it("skips the bundled binary when the platform has none", () => {
    expect(candidateOrder({ bundled: null })).toEqual(["mariadb-dump", "mysqldump"]);
  });

  it("ignores an empty explicit path", () => {
    expect(candidateOrder({ explicitPath: "", bundled: null })).toEqual([
      "mariadb-dump",
      "mysqldump",
    ]);
  });

  it("never includes a Windows install-directory probe", () => {
    const candidates = candidateOrder({ explicitPath: "/usr/bin/mariadb-dump", bundled });
    expect(candidates.some((candidate) => /Program Files|xampp/i.test(candidate))).toBe(false);
  });
});

describe("transient classification", () => {
  it.each([
    "mysqldump: Error 2013: Lost connection to MySQL server during query",
    "mysqldump: Error 2006: MySQL server has gone away",
    "mysqldump: Error 1412: Table definition has changed, please retry transaction",
  ])("treats %s as transient", (stderr) => {
    expect(isTransientMysqldumpError(stderr)).toBe(true);
  });

  it("does not treat an auth failure as transient", () => {
    expect(
      isTransientMysqldumpError("Access denied for user 'b'@'1.2.3.4' (using password: YES)"),
    ).toBe(false);
  });

  it("waits 30s per attempt for error 1412 and 750ms otherwise", () => {
    const changed = "mysqldump: Error 1412: Table definition has changed";
    expect(isTableDefinitionChangedError(changed)).toBe(true);
    expect(transientRetryDelayMs(changed, 2)).toBe(60_000);
    expect(transientRetryDelayMs("Error 2013: Lost connection to MySQL server", 2)).toBe(1_500);
  });
});

describe("unsupported MySQL-only argument", () => {
  it("detects the MariaDB unknown-variable failure", () => {
    expect(
      hasUnsupportedMysqlSpecificArgError("mysqldump: unknown variable 'column-statistics=0'"),
    ).toBe(true);
    expect(
      hasUnsupportedMysqlSpecificArgError("mariadb-dump: unknown variable 'set-gtid-purged=OFF'"),
    ).toBe(true);
  });

  it("ignores unrelated unknown variables", () => {
    expect(hasUnsupportedMysqlSpecificArgError("unknown variable 'ssl-mode=REQUIRED'")).toBe(false);
  });
});

describe("routine/event privilege classification", () => {
  it("detects an events privilege failure", () => {
    expect(
      isRoutinePrivilegeError(
        "mysqldump: Couldn't execute 'show events': Access denied for user 'b'@'%' to database 'prod' (1044)",
      ),
    ).toBe(true);
  });

  it("does not treat a SHOW VIEW denial as a routine/event problem", () => {
    expect(isRoutinePrivilegeError("SHOW VIEW command denied to user 'b'@'%'")).toBe(false);
  });

  it("classifies a 1045 auth failure as auth, not a privilege problem", () => {
    const stderr = "Access denied for user 'b'@'1.2.3.4' (using password: YES)";
    expect(isAuthFailureError(stderr)).toBe(true);
    expect(isRoutinePrivilegeError(stderr)).toBe(false);
  });

  it("classifies a routine privilege failure as non-auth", () => {
    const stderr = "mysqldump: Couldn't execute 'show function status': Access denied (1370)";
    expect(isAuthFailureError(stderr)).toBe(false);
    expect(isRoutinePrivilegeError(stderr)).toBe(true);
  });
});

describe("FiveM sandbox detection", () => {
  it("recognises the sandbox child-process denial", () => {
    expect(
      isSandboxChildProcessError(
        "Access to this API has been restricted. Use --allow-child-process to manage permissions.",
      ),
    ).toBe(true);
    expect(isSandboxChildProcessError("spawn mariadb-dump ENOENT")).toBe(false);
  });
});

describe("planRetry", () => {
  const mysql = { includeMysqlOnly: true, includeRoutines: true };

  it("drops the MySQL-only flags without consuming an attempt", () => {
    const plan = planRetry("mysqldump: unknown variable 'column-statistics=0'", mysql, 1);
    expect(plan).toEqual({
      state: { includeMysqlOnly: false, includeRoutines: true },
      delayMs: 0,
      consumesAttempt: false,
    });
  });

  it("drops routines and events exactly once", () => {
    const stderr = "mysqldump: Couldn't execute 'show events': Access denied for user to database";
    const first = planRetry(stderr, { includeMysqlOnly: false, includeRoutines: true }, 1);
    expect(first?.state.includeRoutines).toBe(false);
    expect(planRetry(stderr, { includeMysqlOnly: false, includeRoutines: false }, 1)).toBeNull();
  });

  it("retries transient failures up to three attempts", () => {
    const stderr = "mysqldump: Error 2013: Lost connection to MySQL server during query";
    const state = { includeMysqlOnly: false, includeRoutines: true };
    expect(planRetry(stderr, state, 1)).toEqual({ state, delayMs: 750, consumesAttempt: true });
    expect(planRetry(stderr, state, 2)).toEqual({ state, delayMs: 1_500, consumesAttempt: true });
    expect(planRetry(stderr, state, 3)).toBeNull();
  });

  it("does not retry an auth failure", () => {
    expect(
      planRetry(
        "Access denied for user 'b'@'1.2.3.4' (using password: YES)",
        { includeMysqlOnly: false, includeRoutines: true },
        1,
      ),
    ).toBeNull();
  });
});
