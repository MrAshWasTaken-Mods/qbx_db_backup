export interface DiscordConfig {
  webhookUrl?: string;
  botToken?: string;
  channelId?: string;
  isForum?: boolean;
  threadTitle?: string;
  username?: string;
  avatarUrl?: string;
  keepLocal: boolean;
  maxFileSizeMb: number;
}

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbedFooter {
  text: string;
  icon_url?: string;
}

export interface DiscordEmbedAuthor {
  name: string;
  url?: string;
  icon_url?: string;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  timestamp?: string;
  color?: number;
  footer?: DiscordEmbedFooter;
  author?: DiscordEmbedAuthor;
  fields?: DiscordEmbedField[];
}

export interface DiscordAttachmentRef {
  id: number | string;
  filename: string;
  description?: string;
}

export interface DiscordMessagePayload {
  content?: string;
  username?: string;
  avatar_url?: string;
  tts?: boolean;
  embeds?: DiscordEmbed[];
  attachments?: DiscordAttachmentRef[];
  thread_name?: string;
  applied_tags?: string[];
}

export interface DiscordChannel {
  id: string;
  type: number;
  name?: string;
  guild_id?: string;
  parent_id?: string;
}

export interface DiscordThread {
  id: string;
  type: number;
  name: string;
  parent_id?: string;
  archived?: boolean;
  archive_timestamp?: string;
}

export interface DiscordThreadListResponse {
  threads: DiscordThread[];
  has_more?: boolean;
}

export interface DiscordUploadResult {
  messageId?: string;
  channelId?: string;
  threadId?: string;
  fileAttached: boolean;
  warning?: string;
}

export class DiscordError extends Error {
  readonly status?: number;
  readonly code?: number;
  readonly details?: unknown;

  constructor(message: string, options?: { status?: number; code?: number; details?: unknown }) {
    super(message);
    this.name = "DiscordError";
    this.status = options?.status;
    this.code = options?.code;
    this.details = options?.details;
  }
}
