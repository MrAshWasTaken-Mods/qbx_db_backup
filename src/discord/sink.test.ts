import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { DiscordClient } from "./client";
import { DiscordSink } from "./sink";

describe("DiscordSink", () => {
  let tmpDir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "discord-sink-test-"));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("spools zip, sends directly to Discord webhook, and cleans up temp directory", async () => {
    let sent = false;

    globalThis.fetch = mock(async (url: string | URL | Request) => {
      if (url.toString().includes("discord.com/api/webhooks")) {
        sent = true;
        return new Response(JSON.stringify({ id: "msg_sink_123", channel_id: "chan_999" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not Found", { status: 404 });
    }) as unknown as typeof fetch;

    const client = new DiscordClient({
      webhookUrl: "https://discord.com/api/webhooks/123/token_abc",
      isForum: false,
      keepLocal: false,
      maxFileSizeMb: 25,
    });

    const sink = new DiscordSink({
      client,
      fileName: "qbx-2026-09-12_12-00-00Z.zip",
      database: "qbox_db",
      trigger: "manual",
      tmpDir,
    });

    const openSink = await sink.open({ entryName: "dump.sql", zipLevel: 6 });
    openSink.append(Readable.from(["-- MySQL dump test content\nINSERT INTO users VALUES (1);"]));

    const result = await openSink.finish();

    expect(sent).toBe(true);
    expect(result.bytesZip).toBeGreaterThan(0);
    expect(result.sha256).toHaveLength(64);
    expect(result.location).toContain("discord://chan_999");
    expect(result.location).toContain("qbx-2026-09-12_12-00-00Z.zip");

    const remainingFiles = await fs.promises.readdir(tmpDir);
    expect(remainingFiles.length).toBe(0);
  });

  it("supports dual-write with keepLocalPath", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ id: "msg_dual", channel_id: "chan_777" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const localCopyPath = path.join(tmpDir, "local_backups", "backup.zip");
    const client = new DiscordClient({
      webhookUrl: "https://discord.com/api/webhooks/123/token",
      isForum: false,
      keepLocal: true,
      maxFileSizeMb: 25,
    });

    const sink = new DiscordSink({
      client,
      fileName: "backup.zip",
      database: "qbox_db",
      trigger: "scheduled",
      tmpDir,
      keepLocalPath: localCopyPath,
    });

    const openSink = await sink.open({ entryName: "dump.sql", zipLevel: 1 });
    openSink.append(Readable.from(["Sample SQL Content"]));
    const result = await openSink.finish();

    expect(result.location).toContain("local:");
    expect(fs.existsSync(localCopyPath)).toBe(true);
  });

  it("cleans up temp directory on abort", async () => {
    globalThis.fetch = mock(async () => new Response("{}")) as unknown as typeof fetch;
    const client = new DiscordClient({
      webhookUrl: "https://discord.com/api/webhooks/1/tok",
      isForum: false,
      keepLocal: false,
      maxFileSizeMb: 25,
    });

    const sink = new DiscordSink({
      client,
      fileName: "backup.zip",
      database: "qbox_db",
      trigger: "manual",
      tmpDir,
    });

    const openSink = await sink.open({ entryName: "dump.sql", zipLevel: 1 });
    openSink.append(Readable.from(["abort test"]));
    await openSink.abort();

    const remainingFiles = await fs.promises.readdir(tmpDir);
    expect(remainingFiles.length).toBe(0);
  });
});
