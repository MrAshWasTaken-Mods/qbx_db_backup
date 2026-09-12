import {
  type DiscordChannel,
  type DiscordConfig,
  type DiscordEmbed,
  DiscordError,
  type DiscordMessagePayload,
  type DiscordThread,
  type DiscordThreadListResponse,
  type DiscordUploadResult,
} from "./types";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (https://github.com/MrAshWasTaken-Mods/qbx_db_backup, 1.1.0)";
const DEFAULT_MAX_FILE_SIZE_MB = 25;
const MAX_RATE_LIMIT_WAIT_MS = 10_000;

export interface BackupMessageOptions {
  /** Zip file contents as a Blob (preferred — streamed from disk). */
  zipBlob?: Blob;
  /** @deprecated Use zipBlob. Accepted for backward compatibility. */
  zipBuffer?: Buffer | Uint8Array;
  fileName: string;
  sizeBytes: number;
  /** Uncompressed SQL dump size in bytes. When omitted, the embed displays "N/A". */
  rawBytes?: number;
  durationMs: number;
  database: string;
  targetLocation?: string;
  trigger: string;
  warnings?: string[];
  timestamp?: Date;
}

export class DiscordClient {
  readonly config: DiscordConfig;
  private readonly maxFileSizeBytes: number;

  constructor(config: DiscordConfig) {
    if (!config.webhookUrl && (!config.botToken || !config.channelId)) {
      throw new DiscordError("DiscordClient requires either webhookUrl or botToken + channelId");
    }
    this.config = {
      ...config,
      maxFileSizeMb: config.maxFileSizeMb > 0 ? config.maxFileSizeMb : DEFAULT_MAX_FILE_SIZE_MB,
    };
    this.maxFileSizeBytes = this.config.maxFileSizeMb * 1024 * 1024;
  }

  private get authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
    };
    if (this.config.botToken && this.config.botToken.trim().length > 0) {
      headers.Authorization = `Bot ${this.config.botToken.trim()}`;
    }
    return headers;
  }

  private async requestWithRetry<T>(
    url: string,
    init: RequestInit,
    attempt = 1,
  ): Promise<{ status: number; data: T }> {
    const response = await fetch(url, init);

    if (response.status === 429) {
      if (attempt >= 3) {
        throw new DiscordError("Discord API rate limit exceeded after 3 retries", {
          status: 429,
        });
      }

      let retryAfterMs = 1500;
      const retryAfterHeader = response.headers.get("Retry-After");
      if (retryAfterHeader) {
        const parsed = Number.parseFloat(retryAfterHeader);
        if (Number.isFinite(parsed) && parsed > 0) {
          retryAfterMs = parsed * 1000;
        }
      } else {
        try {
          const body = (await response.json()) as { retry_after?: number };
          if (body && typeof body.retry_after === "number") {
            retryAfterMs = body.retry_after * 1000;
          }
        } catch {
          // ignore json parse error
        }
      }

      const waitTime = Math.min(Math.max(500, retryAfterMs), MAX_RATE_LIMIT_WAIT_MS);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      return this.requestWithRetry<T>(url, init, attempt + 1);
    }

    if (!response.ok) {
      let errorDetails: unknown = null;
      let errorMsg = `Discord API error: ${response.status} ${response.statusText}`;
      try {
        const json = (await response.json()) as { message?: string; code?: number };
        errorDetails = json;
        if (json.message) {
          errorMsg = `Discord API error (${json.code ?? response.status}): ${json.message}`;
        }
      } catch {
        // non-json response
      }

      throw new DiscordError(errorMsg, {
        status: response.status,
        code:
          typeof errorDetails === "object" && errorDetails !== null && "code" in errorDetails
            ? (errorDetails as { code: number }).code
            : undefined,
        details: errorDetails,
      });
    }

    if (response.status === 204) {
      return { status: 204, data: {} as T };
    }

    const data = (await response.json()) as T;
    return { status: response.status, data };
  }

  /** Applies config-level username/avatar defaults to a payload copy. */
  private applyConfigDefaults(payload: DiscordMessagePayload): DiscordMessagePayload {
    const copy = { ...payload };
    if (this.config.username && !copy.username) copy.username = this.config.username;
    if (this.config.avatarUrl && !copy.avatar_url) copy.avatar_url = this.config.avatarUrl;
    return copy;
  }

  private buildFormData(
    payload: DiscordMessagePayload,
    file?: { buffer: Buffer | Uint8Array | Blob; filename: string },
  ): FormData {
    const form = new FormData();
    const payloadCopy: DiscordMessagePayload = { ...payload };

    if (file) {
      payloadCopy.attachments = [
        {
          id: 0,
          filename: file.filename,
        },
      ];
    }

    if (this.config.username && !payloadCopy.username) {
      payloadCopy.username = this.config.username;
    }
    if (this.config.avatarUrl && !payloadCopy.avatar_url) {
      payloadCopy.avatar_url = this.config.avatarUrl;
    }

    form.append("payload_json", JSON.stringify(payloadCopy));

    if (file) {
      const blob =
        file.buffer instanceof Blob
          ? file.buffer
          : new Blob([file.buffer], { type: "application/zip" });
      form.append("files[0]", blob, file.filename);
    }

    return form;
  }

  formatThreadTitle(date: Date): string {
    const pattern = this.config.threadTitle || "Database Backup - {date}";
    const pad = (n: number) => n.toString().padStart(2, "0");
    const year = date.getUTCFullYear();
    const month = pad(date.getUTCMonth() + 1);
    const day = pad(date.getUTCDate());
    const hours = pad(date.getUTCHours());
    const minutes = pad(date.getUTCMinutes());
    const seconds = pad(date.getUTCSeconds());

    const dateStr = `${year}-${month}-${day}`;
    const timeStr = `${hours}:${minutes}:${seconds} UTC`;
    const datetimeStr = `${dateStr} ${timeStr}`;

    return pattern
      .replace(/\{date\}/gi, dateStr)
      .replace(/\{time\}/gi, timeStr)
      .replace(/\{datetime\}/gi, datetimeStr);
  }

  async sendWebhook(
    payload: DiscordMessagePayload,
    file?: { buffer: Buffer | Uint8Array | Blob; filename: string },
    threadId?: string,
  ): Promise<DiscordUploadResult> {
    if (!this.config.webhookUrl) {
      throw new DiscordError("No Discord webhook URL configured");
    }

    let url = this.config.webhookUrl.trim();
    const separator = url.includes("?") ? "&" : "?";
    url = `${url}${separator}wait=true`;

    if (threadId) {
      url = `${url}&thread_id=${encodeURIComponent(threadId)}`;
    }

    const form = this.buildFormData(payload, file);
    const result = await this.requestWithRetry<{ id?: string; channel_id?: string }>(url, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
      },
      body: form,
    });

    return {
      messageId: result.data.id,
      channelId: result.data.channel_id,
      threadId,
      fileAttached: Boolean(file),
    };
  }

  async sendChannelMessage(
    channelId: string,
    payload: DiscordMessagePayload,
    file?: { buffer: Buffer | Uint8Array | Blob; filename: string },
  ): Promise<DiscordUploadResult> {
    const url = `${DISCORD_API_BASE}/channels/${channelId}/messages`;
    const form = this.buildFormData(payload, file);

    const result = await this.requestWithRetry<{ id: string; channel_id: string }>(url, {
      method: "POST",
      headers: this.authHeaders,
      body: form,
    });

    return {
      messageId: result.data.id,
      channelId: result.data.channel_id,
      fileAttached: Boolean(file),
    };
  }

  async createForumThread(
    forumChannelId: string,
    title: string,
    payload: DiscordMessagePayload,
    file?: { buffer: Buffer | Uint8Array | Blob; filename: string },
  ): Promise<DiscordUploadResult> {
    if (!this.config.botToken) {
      const forumPayload: DiscordMessagePayload = {
        ...payload,
        thread_name: title,
      };
      return this.sendWebhook(forumPayload, file);
    }

    const url = `${DISCORD_API_BASE}/channels/${forumChannelId}/threads`;
    const form = new FormData();
    const resolvedPayload = this.applyConfigDefaults(payload);

    const threadPayload = {
      name: title,
      auto_archive_duration: 1440,
      message: {
        content: resolvedPayload.content,
        embeds: resolvedPayload.embeds,
        attachments: file
          ? [
              {
                id: 0,
                filename: file.filename,
              },
            ]
          : undefined,
      },
    };

    form.append("payload_json", JSON.stringify(threadPayload));

    if (file) {
      const blob =
        file.buffer instanceof Blob
          ? file.buffer
          : new Blob([file.buffer], { type: "application/zip" });
      form.append("files[0]", blob, file.filename);
    }

    const result = await this.requestWithRetry<DiscordThread & { message?: { id: string } }>(url, {
      method: "POST",
      headers: this.authHeaders,
      body: form,
    });

    return {
      messageId: result.data.message?.id,
      channelId: forumChannelId,
      threadId: result.data.id,
      fileAttached: Boolean(file),
    };
  }

  async findTodayForumThread(forumChannelId: string, date: Date): Promise<DiscordThread | null> {
    if (!this.config.botToken) return null;

    const pad = (n: number) => n.toString().padStart(2, "0");
    const dateStr = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

    // Check active threads in the forum channel
    try {
      const activeRes = await this.requestWithRetry<DiscordThreadListResponse>(
        `${DISCORD_API_BASE}/channels/${forumChannelId}/threads/active`,
        {
          method: "GET",
          headers: this.authHeaders,
        },
      );

      const activeMatch = activeRes.data.threads?.find((t) => t.name?.includes(dateStr));
      if (activeMatch) return activeMatch;
    } catch {
      // ignore active threads query error
    }

    // Search archived threads with pagination (max 100 per page)
    try {
      let before: string | undefined;
      const MAX_PAGES = 10;

      for (let page = 0; page < MAX_PAGES; page++) {
        const params = new URLSearchParams({ limit: "100" });
        if (before) params.set("before", before);

        const archivedRes = await this.requestWithRetry<DiscordThreadListResponse>(
          `${DISCORD_API_BASE}/channels/${forumChannelId}/threads/archived/public?${params}`,
          {
            method: "GET",
            headers: this.authHeaders,
          },
        );

        const threads = archivedRes.data.threads ?? [];
        const archivedMatch = threads.find((t) => t.name?.includes(dateStr));

        if (archivedMatch) {
          if (archivedMatch.archived) {
            try {
              // Unarchive thread before posting
              const unarchived = await this.requestWithRetry<DiscordThread>(
                `${DISCORD_API_BASE}/channels/${archivedMatch.id}`,
                {
                  method: "PATCH",
                  headers: {
                    ...this.authHeaders,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({ archived: false }),
                },
              );
              return unarchived.data;
            } catch {
              // If unarchiving fails, attempt posting anyway
              return archivedMatch;
            }
          }
          return archivedMatch;
        }

        if (!archivedRes.data.has_more || threads.length === 0) break;
        before = threads[threads.length - 1]?.id;
      }
    } catch {
      // ignore archived threads query error
    }

    return null;
  }

  async sendBackup(options: BackupMessageOptions): Promise<DiscordUploadResult> {
    const timestamp = options.timestamp ?? new Date();
    const isExceeded = options.sizeBytes > this.maxFileSizeBytes;

    const embed: DiscordEmbed = {
      title: "Database Backup Complete",
      color: isExceeded ? 0xfee75c : 0x57f287,
      timestamp: timestamp.toISOString(),
      footer: {
        text: `qbx_db_backup - ${options.fileName}`,
      },
      fields: [
        { name: "Database", value: `\`${options.database}\``, inline: true },
        { name: "Trigger", value: `\`${options.trigger}\``, inline: true },
        { name: "Archive Size", value: formatBytes(options.sizeBytes), inline: true },
        {
          name: "Raw SQL Size",
          value: options.rawBytes !== undefined ? formatBytes(options.rawBytes) : "N/A",
          inline: true,
        },
        { name: "Duration", value: `${(options.durationMs / 1000).toFixed(1)}s`, inline: true },
        {
          name: "Location",
          value: options.targetLocation ? `\`${options.targetLocation}\`` : "Discord",
          inline: true,
        },
      ],
    };

    if (options.warnings && options.warnings.length > 0) {
      embed.fields?.push({
        name: "Warnings",
        value: options.warnings.join("\n"),
        inline: false,
      });
    }

    let warningNote: string | undefined;
    if (isExceeded) {
      warningNote = `Backup zip (${formatBytes(options.sizeBytes)}) exceeds Discord upload limit (${this.config.maxFileSizeMb} MB). Saved safely at: ${options.targetLocation ?? "server storage"}.`;
      embed.fields?.push({
        name: "Attachment Skipped",
        value: warningNote,
        inline: false,
      });
    }

    const payload: DiscordMessagePayload = {
      embeds: [embed],
    };

    // Streamed blob takes precedence over in-memory buffer
    const fileBuffer =
      options.zipBlob ?? (options.zipBuffer ? new Blob([options.zipBuffer]) : undefined);
    const fileToAttach =
      !isExceeded && fileBuffer ? { buffer: fileBuffer, filename: options.fileName } : undefined;

    if (this.config.isForum) {
      const channelId = this.config.channelId;
      const title = this.formatThreadTitle(timestamp);

      if (this.config.botToken && channelId) {
        const existingThread = await this.findTodayForumThread(channelId, timestamp);
        if (existingThread) {
          const res = await this.sendChannelMessage(existingThread.id, payload, fileToAttach);
          return { ...res, threadId: existingThread.id, warning: warningNote };
        }
        const res = await this.createForumThread(channelId, title, payload, fileToAttach);
        return { ...res, warning: warningNote };
      }

      // Webhooks cannot query or append to existing forum threads without a bot token,
      // so each webhook backup creates a new thread in the forum.
      const res = await this.sendWebhook({ ...payload, thread_name: title }, fileToAttach);
      return { ...res, warning: warningNote };
    }

    if (this.config.botToken && this.config.channelId) {
      const res = await this.sendChannelMessage(this.config.channelId, payload, fileToAttach);
      return { ...res, warning: warningNote };
    }

    if (this.config.webhookUrl) {
      const res = await this.sendWebhook(payload, fileToAttach);
      return { ...res, warning: warningNote };
    }

    throw new DiscordError("No valid Discord Webhook URL or Bot Token + Channel ID configured");
  }

  async testConnection(): Promise<{
    ok: boolean;
    type: "webhook" | "bot";
    name?: string;
    channelId?: string;
    guildId?: string;
    isForum?: boolean;
  }> {
    if (this.config.botToken && this.config.channelId) {
      const url = `${DISCORD_API_BASE}/channels/${this.config.channelId}`;
      const res = await this.requestWithRetry<DiscordChannel>(url, {
        method: "GET",
        headers: this.authHeaders,
      });
      return {
        ok: true,
        type: "bot",
        name: res.data.name,
        channelId: res.data.id,
        guildId: res.data.guild_id,
        isForum: res.data.type === 15,
      };
    }

    if (this.config.webhookUrl) {
      const res = await this.requestWithRetry<{
        name?: string;
        channel_id?: string;
        guild_id?: string;
      }>(this.config.webhookUrl, {
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
        },
      });
      return {
        ok: true,
        type: "webhook",
        name: res.data.name,
        channelId: res.data.channel_id,
        guildId: res.data.guild_id,
        isForum: this.config.isForum,
      };
    }

    throw new DiscordError("Neither Discord Webhook URL nor Bot Token + Channel ID configured");
  }
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unitIdx = 0;
  while (size >= 1024 && unitIdx < units.length - 1) {
    size /= 1024;
    unitIdx += 1;
  }
  return `${unitIdx === 0 ? size : size.toFixed(1)} ${units[unitIdx]}`;
}
