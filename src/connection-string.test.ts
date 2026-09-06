import { describe, expect, it } from "bun:test";
import { redactConnectionString } from "./config";
import { describeTarget, parseConnectionString } from "./connection-string";

describe("parseConnectionString (URI form)", () => {
  it("parses a full mysql:// URI", () => {
    const target = parseConnectionString(
      "mysql://user:pass@db.example.com:3307/fivem?ssl=true&charset=utf8mb4",
    );
    expect(target).toEqual({
      host: "db.example.com",
      port: 3307,
      user: "user",
      password: "pass",
      database: "fivem",
      ssl: true,
    });
  });

  it("defaults the port to 3306 and ssl to false", () => {
    const target = parseConnectionString("mysql://root:secret@localhost/qbox");
    expect(target.port).toBe(3306);
    expect(target.ssl).toBe(false);
  });

  it("accepts the mariadb:// scheme", () => {
    expect(parseConnectionString("mariadb://root:x@127.0.0.1/qbox").host).toBe("127.0.0.1");
  });

  it("rejects other schemes", () => {
    expect(() => parseConnectionString("postgres://root:x@127.0.0.1/qbox")).toThrow(
      /not supported/i,
    );
  });

  it("percent-decodes a password containing @ and :", () => {
    const target = parseConnectionString("mysql://ro%40ot:p%40ss%3Aword@localhost:3306/fivem");
    expect(target.user).toBe("ro@ot");
    expect(target.password).toBe("p@ss:word");
    expect(target.database).toBe("fivem");
  });

  it("allows an empty password", () => {
    expect(parseConnectionString("mysql://root:@127.0.0.1:3306/qbox").password).toBe("");
    expect(parseConnectionString("mysql://root@127.0.0.1:3306/qbox").password).toBe("");
  });

  it("throws when the database is missing", () => {
    expect(() => parseConnectionString("mysql://root:x@127.0.0.1:3306/")).toThrow(
      /missing the database name/,
    );
  });
});

describe("parseConnectionString (key/value form)", () => {
  it("parses the oxmysql key/value form", () => {
    expect(
      parseConnectionString("user=root;password=12345;host=localhost;port=3306;database=fivem"),
    ).toEqual({
      host: "localhost",
      port: 3306,
      user: "root",
      password: "12345",
      database: "fivem",
      ssl: false,
    });
  });

  it("accepts aliases and is case-insensitive on keys", () => {
    const target = parseConnectionString(
      "UID=admin;PWD=hunter2;Data Source=db.internal;Initial Catalog=qbox;SSL=yes",
    );
    expect(target).toEqual({
      host: "db.internal",
      port: 3306,
      user: "admin",
      password: "hunter2",
      database: "qbox",
      ssl: true,
    });
  });

  it("accepts server/hostname/username/dbname aliases", () => {
    const target = parseConnectionString(
      "username=svc; server=10.0.0.5; port=3307; dbname=core; password=p",
    );
    expect(describeTarget(target)).toBe("svc@10.0.0.5:3307/core");
  });

  it("strips quotes and surrounding whitespace", () => {
    const target = parseConnectionString(
      `  user = 'root' ; password = "pa ss" ; host = 'localhost' ; database = "fivem" ; `,
    );
    expect(target.user).toBe("root");
    expect(target.password).toBe("pa ss");
    expect(target.database).toBe("fivem");
  });

  it("allows an empty password", () => {
    expect(parseConnectionString("user=root;password=;host=localhost;database=qbox").password).toBe(
      "",
    );
  });

  it("throws when the host is missing", () => {
    expect(() => parseConnectionString("user=root;password=x;database=qbox")).toThrow(
      /missing the database host/,
    );
  });

  it("throws when the user is missing", () => {
    expect(() => parseConnectionString("host=localhost;password=x;database=qbox")).toThrow(
      /missing the database user/,
    );
  });

  it("throws when the database is missing", () => {
    expect(() => parseConnectionString("host=localhost;user=root;password=x")).toThrow(
      /missing the database name/,
    );
  });

  it("throws on an empty string", () => {
    expect(() => parseConnectionString("   ")).toThrow(/empty/i);
  });
});

describe("redactConnectionString", () => {
  it("hides the password in the URI form", () => {
    const redacted = redactConnectionString("mysql://root:sup3rs3cret@localhost:3306/fivem");
    expect(redacted).toBe("mysql://root:***@localhost:3306/fivem");
    expect(redacted).not.toContain("sup3rs3cret");
  });

  it("hides a URI password containing a literal @", () => {
    expect(redactConnectionString("mysql://user:p@ss@localhost:3306/db")).toBe(
      "mysql://user:***@localhost:3306/db",
    );
  });

  it("hides percent-encoded URI passwords", () => {
    expect(redactConnectionString("mariadb://root:p%40ss@localhost/db")).not.toContain("p%40ss");
  });

  it("hides the password in the key/value form", () => {
    const redacted = redactConnectionString(
      "user=root;password=sup3rs3cret;host=localhost;database=fivem",
    );
    expect(redacted).toBe("user=root;password=***;host=localhost;database=fivem");
    expect(redacted).not.toContain("sup3rs3cret");
  });

  it("hides the pwd alias", () => {
    expect(redactConnectionString("UID=root;PWD=hunter2;Server=db")).not.toContain("hunter2");
  });

  it("returns an empty string unchanged", () => {
    expect(redactConnectionString("")).toBe("");
  });
});
