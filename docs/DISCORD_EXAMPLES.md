# Discord Backup Delivery & Storage Guide

`qbx_db_backup` supports sending database backup `.zip` files and status embeds directly to Discord via **Discord Webhooks** or a **Discord Bot Token**.

You can send backups to:
1. **Regular Text Channels** (posts as a message with attachment + embed)
2. **Discord Forum Channels** (automatically groups backups by day in daily threads like `Database Backup - 2026-09-12`)

---

## Configuration Options

### 1. Discord Webhook (Simplest Setup)

Webhooks require no bot creation and can post to text channels or create forum posts.

#### A. Webhook to a Standard Text Channel

```cfg
# Enable Discord destination
set qbx_backup_destination "discord"

# Discord Webhook URL (from Channel Settings -> Integrations -> Webhooks)
set qbx_db_backup_discord_webhook_url "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_TOKEN"

# Optional Customization
set qbx_db_backup_discord_username "Server Database Backups"
set qbx_db_backup_discord_avatar_url "https://raw.githubusercontent.com/Qbox-project/assets/main/logos/logo.png"

# Optional: keep a local copy on the server disk as well
set qbx_db_backup_discord_keep_local "1"
```

#### B. Webhook to a Forum Channel

```cfg
set qbx_backup_destination "discord"
set qbx_db_backup_discord_webhook_url "https://discord.com/api/webhooks/123456789012345678/TOKEN"
set qbx_db_backup_discord_is_forum "1"
set qbx_db_backup_discord_thread_title "Database Backup - {date}"
```

---

### 2. Discord Bot Token (Advanced / Daily Forum Threads)

Using a Bot Token allows `qbx_db_backup` to check for existing forum threads for the current day and group all backup runs (hourly or scheduled) into that day's thread.

#### A. Bot Token to a Forum Channel (Daily Thread Grouping)

```cfg
set qbx_backup_destination "discord"

# Discord Bot Token (from Discord Developer Portal -> Bot -> Reset Token)
set qbx_db_backup_discord_bot_token "MTEyMjMzNDQ1NQ.YourBotTokenHere"

# Channel ID of your Forum Channel (Right-click Forum Channel -> Copy Channel ID)
set qbx_db_backup_discord_channel_id "123456789012345678"

# Enable Forum Mode
set qbx_db_backup_discord_is_forum "1"

# Thread Title Pattern (supports {date}, {time}, {datetime})
set qbx_db_backup_discord_thread_title "Database Backup - {date}"

# Optional: keep local copy on disk
set qbx_db_backup_discord_keep_local "1"
```

#### How Daily Forum Grouping Works:
1. When a backup runs, the bot checks active and archived threads in the forum channel for a thread containing today's date (`YYYY-MM-DD`).
2. If today's thread exists (e.g. `Database Backup - 2026-09-12`), it sends the backup message and `.zip` file inside that thread.
3. If no thread exists yet for today, it automatically creates a new post/thread with the title `Database Backup - 2026-09-12` and sets the auto-archive duration to 24 hours.

#### B. Bot Token to a Standard Text Channel

```cfg
set qbx_backup_destination "discord"
set qbx_db_backup_discord_bot_token "MTEyMjMzNDQ1NQ.YourBotTokenHere"
set qbx_db_backup_discord_channel_id "123456789012345678"
set qbx_db_backup_discord_is_forum "0"
```

---

### 3. Multi-Cloud / Failover Chain Integration

You can configure Discord alongside S3 or Google Drive. If your primary cloud target experiences an outage, `qbx_db_backup` will automatically fall back to Discord:

```cfg
# Primary target is S3
set qbx_backup_destination "s3"
set qbx_db_backup_s3_bucket "my-bucket"
set qbx_db_backup_s3_access_key_id "KEY"
set qbx_db_backup_s3_secret_access_key "SECRET"

# Discord fallback / notification backup
set qbx_db_backup_discord_webhook_url "https://discord.com/api/webhooks/..."
```

---

## Required Bot Permissions

If using a **Bot Token**, invite your bot to your Discord server with the following channel permissions:
- `View Channel`
- `Send Messages`
- `Attach Files`
- `Read Message History`
- `Send Messages in Threads` (for Forum / Thread channels)
- `Create Public Threads` (for Forum channels)

---

## Convar Reference

| Convar | Default | Description |
| :--- | :--- | :--- |
| `qbx_backup_destination` | `"local"` | Set to `"discord"` to use Discord as primary backup target |
| `qbx_db_backup_discord_webhook_url` | `""` | Discord Webhook URL |
| `qbx_db_backup_discord_bot_token` | `""` | Discord Bot Token |
| `qbx_db_backup_discord_channel_id` | `""` | Discord Channel ID (Text Channel or Forum Channel) |
| `qbx_db_backup_discord_is_forum` | `"0"` | Set to `"1"` for Forum channels |
| `qbx_db_backup_discord_thread_title` | `"Database Backup - {date}"` | Thread title pattern (`{date}`, `{time}`, `{datetime}`) |
| `qbx_db_backup_discord_username` | `""` | Custom webhook sender username |
| `qbx_db_backup_discord_avatar_url` | `""` | Custom webhook avatar URL |
| `qbx_db_backup_discord_keep_local` | `"0"` | Keep a copy of the backup zip in `backups/` locally |
| `qbx_db_backup_discord_max_file_size_mb` | `"25"` | Maximum file size for Discord attachments in MB |

---

## Discord File Size Limit (25 MiB) Handling

Discord limits bot and webhook uploads to **25 MiB** (or up to 50/500 MiB on boosted servers).

- **If backup is ≤ 25 MB:** The `.zip` file is attached directly to the Discord message with a detailed status embed.
- **If backup exceeds 25 MB:** Rather than failing the backup pipeline, `qbx_db_backup` will safely send a detailed summary embed to Discord with an informational note (`Attachment Skipped: File exceeds 25MB`), while preserving the full `.zip` file in your local storage or secondary cloud destination.