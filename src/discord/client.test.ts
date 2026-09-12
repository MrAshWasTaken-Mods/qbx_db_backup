import { afterEach, describe, expect, it, mock } from "bun:test";
import { DiscordClient } from "./client";

describe("Discord Client Engine", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws when initialized without credentials", () => {
    expect(() => {
      new DiscordClient({
        keepLocal: false,
        maxFileSizeMb: 25,
      });
    }).toThrow("DiscordClient requires either webhookUrl or botToken + channelId");
  });

  it("sends message via Webhook with multipart payload", async () => {
    let capturedUrl = "";
    let capturedBody: FormData | undefined;

    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedBody = init?.body as FormData;
      return new Response(JSON.stringify({ id: "msg_12345", channel_id: "chan_9999" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = new DiscordClient({
      webhookUrl: "https://discord.com/api/webhooks/123456789/abcdefghijk",
      username: "Qbox Backup Bot",
      avatarUrl: "https://example.com/avatar.png",
      keepLocal: false,
      maxFileSizeMb: 25,
    });

    const result = await client.sendWebhook({ content: "Backup completed!" });
    expect(capturedUrl).toContain("https://discord.com/api/webhooks/123456789/abcdefghijk");
    expect(capturedUrl).toContain("wait=true");
    expect(result.messageId).toBe("msg_12345");
    expect(result.channelId).toBe("chan_9999");
    expect(capturedBody).toBeDefined();

    const payloadJson = capturedBody?.get("payload_json") as string;
    expect(payloadJson).toBeDefined();
    const parsed = JSON.parse(payloadJson);
    expect(parsed.username).toBe("Qbox Backup Bot");
    expect(parsed.avatar_url).toBe("https://example.com/avatar.png");
  });

  it("sends message via Bot Token with Authorization header", async () => {
    let capturedHeaders: HeadersInit | undefined;

    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({ id: "msg_777", channel_id: "chan_888" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = new DiscordClient({
      botToken: "MTEyMjMzNDQ1NQ.secret_token",
      channelId: "chan_888",
      isForum: false,
      keepLocal: false,
      maxFileSizeMb: 25,
    });

    const result = await client.sendChannelMessage("chan_888", { content: "Test" });
    const auth =
      (capturedHeaders as Record<string, string>)?.Authorization ??
      (capturedHeaders as Record<string, string>)?.authorization;
    expect(auth).toBe("Bot MTEyMjMzNDQ1NQ.secret_token");
    expect(result.messageId).toBe("msg_777");
  });

  it("creates a forum thread with Bot Token and applies username/avatar", async () => {
    let capturedUrl = "";
    let capturedPayload: {
      name?: string;
      auto_archive_duration?: number;
      message?: { content?: string; embeds?: unknown[] };
    } = {};

    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url.toString();
      const form = init?.body as FormData;
      const payloadStr = form?.get?.("payload_json") as string;
      if (payloadStr) {
        capturedPayload = JSON.parse(payloadStr);
      }
      return new Response(
        JSON.stringify({
          id: "thread_123",
          name: "Database Backup - 2026-09-12",
          message: { id: "msg_init_1" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const client = new DiscordClient({
      botToken: "MTEyMjMzNDQ1NQ.secret_token",
      channelId: "forum_chan_001",
      username: "Custom Forum Bot",
      avatarUrl: "https://example.com/bot.png",
      isForum: true,
      keepLocal: false,
      maxFileSizeMb: 25,
    });

    const result = await client.createForumThread(
      "forum_chan_001",
      "Database Backup - 2026-09-12",
      {
        content: "Initial post",
      },
    );
    expect(capturedUrl).toContain("/channels/forum_chan_001/threads");
    expect(capturedPayload.name).toBe("Database Backup - 2026-09-12");
    expect(capturedPayload.auto_archive_duration).toBe(1440);
    expect(result.threadId).toBe("thread_123");
  });

  it("finds active forum thread matching today's date", async () => {
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const u = url.toString();
      if (u.includes("/threads/active")) {
        return new Response(
          JSON.stringify({
            threads: [
              { id: "thread_active_99", name: "Database Backup - 2026-09-12", archived: false },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ threads: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new DiscordClient({
      botToken: "MTEyMjMzNDQ1NQ.secret_token",
      channelId: "forum_chan_001",
      isForum: true,
      keepLocal: false,
      maxFileSizeMb: 25,
    });

    const found = await client.findTodayForumThread(
      "forum_chan_001",
      new Date("2026-09-12T12:00:00Z"),
    );
    expect(found).not.toBeNull();
    expect(found?.id).toBe("thread_active_99");
  });

  it("finds archived forum thread and unarchives it returning fresh object", async () => {
    let unarchived = false;

    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const u = url.toString();
      if (u.includes("/threads/active")) {
        return new Response(JSON.stringify({ threads: [] }), { status: 200 });
      }
      if (u.includes("/threads/archived/public")) {
        return new Response(
          JSON.stringify({
            threads: [
              { id: "thread_archived_77", name: "Database Backup - 2026-09-12", archived: true },
            ],
            has_more: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.includes("/channels/thread_archived_77") && init?.method === "PATCH") {
        unarchived = true;
        return new Response(
          JSON.stringify({
            id: "thread_archived_77",
            name: "Database Backup - 2026-09-12",
            archived: false,
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const client = new DiscordClient({
      botToken: "MTEyMjMzNDQ1NQ.secret_token",
      channelId: "forum_chan_001",
      isForum: true,
      keepLocal: false,
      maxFileSizeMb: 25,
    });

    const found = await client.findTodayForumThread(
      "forum_chan_001",
      new Date("2026-09-12T12:00:00Z"),
    );
    expect(found).not.toBeNull();
    expect(found?.id).toBe("thread_archived_77");
    expect(found?.archived).toBe(false);
    expect(unarchived).toBe(true);
  });

  it("paginates through archived threads to find today's thread across multiple pages", async () => {
    const requestedUrls: string[] = [];

    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const u = url.toString();
      requestedUrls.push(u);

      if (u.includes("/threads/active")) {
        return new Response(JSON.stringify({ threads: [] }), { status: 200 });
      }
      if (u.includes("/threads/archived/public")) {
        if (!u.includes("before=")) {
          // Page 1: returns older threads, has_more=true
          return new Response(
            JSON.stringify({
              threads: [
                { id: "thread_old_1", name: "Database Backup - 2026-09-10", archived: true },
                { id: "thread_old_2", name: "Database Backup - 2026-09-09", archived: true },
              ],
              has_more: true,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        } else if (u.includes("before=thread_old_2")) {
          // Page 2: returns today's thread
          return new Response(
            JSON.stringify({
              threads: [
                { id: "thread_target_today", name: "Database Backup - 2026-09-12", archived: true },
              ],
              has_more: false,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
      }
      if (u.includes("/channels/thread_target_today") && init?.method === "PATCH") {
        return new Response(
          JSON.stringify({
            id: "thread_target_today",
            name: "Database Backup - 2026-09-12",
            archived: false,
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const client = new DiscordClient({
      botToken: "MTEyMjMzNDQ1NQ.secret_token",
      channelId: "forum_chan_001",
      isForum: true,
      keepLocal: false,
      maxFileSizeMb: 25,
    });

    const found = await client.findTodayForumThread(
      "forum_chan_001",
      new Date("2026-09-12T12:00:00Z"),
    );

    expect(found).not.toBeNull();
    expect(found?.id).toBe("thread_target_today");
    expect(requestedUrls.some((u) => u.includes("before=thread_old_2"))).toBe(true);
  });

  it("shows N/A for Raw SQL Size when rawBytes is omitted and displays formatted bytes when present", async () => {
    let capturedEmbeds: Array<{ fields?: Array<{ name: string; value: string }> }> = [];

    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init?.body as FormData;
      const payloadStr = form.get("payload_json") as string;
      const parsed = JSON.parse(payloadStr);
      capturedEmbeds = parsed.embeds || [];
      return new Response(JSON.stringify({ id: "msg_embed", channel_id: "chan_123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = new DiscordClient({
      webhookUrl: "https://discord.com/api/webhooks/123/abc",
      keepLocal: false,
      maxFileSizeMb: 25,
    });

    // 1. Without rawBytes (N/A)
    await client.sendBackup({
      fileName: "backup.zip",
      sizeBytes: 1024 * 1024,
      durationMs: 500,
      database: "qbox_db",
      trigger: "manual",
      zipBlob: new Blob(["sample"]),
    });

    let rawField = capturedEmbeds[0]?.fields?.find((f) => f.name === "Raw SQL Size");
    expect(rawField?.value).toBe("N/A");

    // 2. With rawBytes
    await client.sendBackup({
      fileName: "backup.zip",
      sizeBytes: 1024 * 1024,
      rawBytes: 5 * 1024 * 1024,
      durationMs: 500,
      database: "qbox_db",
      trigger: "manual",
      zipBlob: new Blob(["sample"]),
    });

    rawField = capturedEmbeds[0]?.fields?.find((f) => f.name === "Raw SQL Size");
    expect(rawField?.value).toBe("5.0 MB");
  });

  it("skips attachment when file size exceeds maximum limit", async () => {
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({ id: "msg_large", channel_id: "chan_9999" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = new DiscordClient({
      webhookUrl: "https://discord.com/api/webhooks/123456789/abcdefghijk",
      keepLocal: false,
      maxFileSizeMb: 1,
    });

    const largeBlob = new Blob([new Uint8Array(2 * 1024 * 1024)]);

    const result = await client.sendBackup({
      fileName: "large-backup.zip",
      sizeBytes: 2 * 1024 * 1024,
      durationMs: 1200,
      database: "qbox",
      trigger: "manual",
      zipBlob: largeBlob,
    });

    expect(result.fileAttached).toBe(false);
    expect(result.warning).toContain("exceeds Discord upload limit");
    const form = capturedInit?.body as FormData;
    const payloadStr = form.get("payload_json") as string;
    expect(payloadStr).toContain("Attachment Skipped");
    expect(form.get("files[0]")).toBeNull();
  });

  it("retries on HTTP 429 rate limit with Retry-After header", async () => {
    let attempts = 0;

    globalThis.fetch = mock(async () => {
      attempts++;
      if (attempts === 1) {
        return new Response(JSON.stringify({ message: "Rate limited", retry_after: 0.05 }), {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "0.05",
          },
        });
      }
      return new Response(JSON.stringify({ id: "msg_success", channel_id: "chan_9999" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = new DiscordClient({
      webhookUrl: "https://discord.com/api/webhooks/123456789/abcdefghijk",
      keepLocal: false,
      maxFileSizeMb: 25,
    });

    const result = await client.sendWebhook({ content: "Rate limit test" });
    expect(attempts).toBe(2);
    expect(result.messageId).toBe("msg_success");
  });

  it("throws DiscordError on 403 Forbidden with details", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ code: 50001, message: "Missing Access" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = new DiscordClient({
      botToken: "invalid_token",
      channelId: "chan_secret",
      isForum: false,
      keepLocal: false,
      maxFileSizeMb: 25,
    });

    await expect(
      client.sendChannelMessage("chan_secret", { content: "Forbidden" }),
    ).rejects.toThrow("Missing Access");
  });

  it("tests connection successfully for bot token", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ id: "chan_888", type: 0, name: "backups" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = new DiscordClient({
      botToken: "valid_token",
      channelId: "chan_888",
      isForum: false,
      keepLocal: false,
      maxFileSizeMb: 25,
    });

    const diag = await client.testConnection();
    expect(diag.ok).toBe(true);
    expect(diag.name).toBe("backups");
  });
});
