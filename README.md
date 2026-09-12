# qbx_db_backup

Backs up your FiveM server's MySQL/MariaDB database from inside the server. The dump runs on the
machine itself, so the database never has to be reachable from the internet and your credentials
never leave it.

- **Standalone**: run a backup from the console and the zip lands next to the resource.
- **Discord (Webhook or Bot)**: stream backup zips directly to Discord channels or forum channels (grouped into daily threads).
- **Google Drive (100% Free)**: stream backups directly to your personal Google Drive (15 GB free) with zero API costs or credit cards.
- **Universal S3 storage**: upload directly to Cloudflare R2, AWS S3, Wasabi, Backblaze B2, or MinIO.
- **With the Qbox dashboard**: the same backups, sent off-site, with history and alerts.
- **Nothing to install**: `mariadb-dump` is bundled for Windows and Linux (x64).

## Install

1. Download the latest release from GitHub Releases and extract it into `resources/`, or clone this
   repository as `resources/qbx_db_backup`.
2. Add to `server.cfg`, after your `mysql_connection_string`:

```cfg
add_unsafe_child_process_permission "qbx_db_backup"
ensure qbx_db_backup
```

3. Restart the server.

The permission line is required: FiveM blocks resources from starting programs unless you allow
it, and the backup runs `mariadb-dump` as a separate process so the server never slows down.

## Usage

From the server console:

| Command | What it does |
| --- | --- |
| `qbx_db_backup run` | Back up now. Standalone: writes the zip to `resources/qbx_db_backup/backups/`. Connected: uploads to Discord, Google Drive, S3, or the dashboard. |
| `qbx_db_backup status` | Shows the current mode, target database, schedule, and the last result. |
| `qbx_db_backup test` | Checks the configuration and cloud/discord connectivity without touching the database. |
| `qbx_db_backup version` | Prints the version. |

To connect the resource to the Qbox dashboard, paste the token from your organisation's backup
settings:

```cfg
set qbx_db_backup_token "your-token"
```

In all modes a backup runs automatically every `qbx_db_backup_interval_hours` hours (hourly by
default), and `qbx_db_backup run` in the server console is how you start one by hand.

## Discord Delivery (Webhook or Bot Token)

To send backups directly to a Discord text channel or forum channel:

```cfg
set qbx_backup_destination "discord"
set qbx_db_backup_discord_webhook_url "https://discord.com/api/webhooks/..."
```

For Forum Channels with automatic daily thread grouping (`Database Backup - 2026-09-12`):

```cfg
set qbx_backup_destination "discord"
set qbx_db_backup_discord_bot_token "MTEyMjMzNDQ1NQ.YourBotToken"
set qbx_db_backup_discord_channel_id "123456789012345678"
set qbx_db_backup_discord_is_forum "1"
```

See [docs/DISCORD_EXAMPLES.md](docs/DISCORD_EXAMPLES.md) for full configuration examples and setup instructions.

## Google Drive Storage (100% Free)

To stream backups directly to Google Drive using your personal account's 15 GB free storage:

```cfg
set qbx_backup_destination "gdrive"
set qbx_backup_gdrive_client_id "your-client-id.apps.googleusercontent.com"
set qbx_backup_gdrive_client_secret "GOCSPX-yourClientSecret"
set qbx_backup_gdrive_refresh_token "1//04yourRefreshToken"
set qbx_backup_gdrive_folder_id "1A2B3C4D5E6F7G8H9..."
set qbx_backup_gdrive_keep "14"
```

See [docs/GDRIVE_EXAMPLES.md](docs/GDRIVE_EXAMPLES.md) for the 3-minute step-by-step setup guide.

## S3 Storage

To upload backups directly to an S3-compatible bucket instead of the dashboard, configure your credentials:

```cfg
set qbx_db_backup_s3_bucket "my-backups"
set qbx_db_backup_s3_key "your-access-key-id"
set qbx_db_backup_s3_secret "your-secret-access-key"
```

See [docs/S3_EXAMPLES.md](docs/S3_EXAMPLES.md) for configuration examples for **Cloudflare R2**, **AWS S3**, **Wasabi**, **Backblaze B2**, **MinIO**, and **DigitalOcean Spaces**.

## Configuration

Everything has a working default. The resource reads the database credentials from the
`mysql_connection_string` convar your database resource already uses.

| Convar | Default | Meaning |
| --- | --- | --- |
| `qbx_backup_destination` | (auto) | Explicit destination: `qbx`, `discord`, `gdrive`, `s3`, or `local`. |
| `qbx_db_backup_token` | (empty) | Dashboard token. Leave empty to run standalone, Discord, GDrive, or S3. |
| `qbx_db_backup_connection_string` | (empty) | Use different credentials than the server does. Same formats as oxmysql. |
| `qbx_db_backup_interval_hours` | `1` | How often to back up, in hours. Minimum 1, 0 disables the schedule. Manual runs always work. |
| `qbx_db_backup_local_keep` | `7` | How many zips to keep in the local folder (standalone, or connected with `keep_local`). |
| `qbx_db_backup_local_max_age_days` | `0` | Delete local backups older than this many days (0 disables age pruning). |
| `qbx_db_backup_min_free_disk_mb` | `0` | Minimum free disk space in MB. Prunes oldest local zips if drive space drops below this. |
| `qbx_db_backup_keep_local` | `0` | When uploading to cloud storage, also keep a copy of each zip in the local folder. |
| `qbx_db_backup_discord_webhook_url` | (empty) | Discord Webhook URL. |
| `qbx_db_backup_discord_bot_token` | (empty) | Discord Bot Token. |
| `qbx_db_backup_discord_channel_id` | (empty) | Discord Channel ID (Text Channel or Forum Channel). |
| `qbx_db_backup_discord_is_forum` | `0` | Set to `1` to enable Forum Channel mode. |
| `qbx_db_backup_discord_thread_title` | `Database Backup - {date}` | Title format for Forum threads. |
| `qbx_db_backup_discord_keep_local` | `0` | Also retain local zip copy when sending to Discord. |
| `qbx_backup_gdrive_client_id` | (empty) | Google Cloud OAuth 2.0 Client ID. |
| `qbx_backup_gdrive_client_secret` | (empty) | Google Cloud OAuth 2.0 Client Secret. |
| `qbx_backup_gdrive_refresh_token` | (empty) | Google OAuth 2.0 1-time Refresh Token. |
| `qbx_backup_gdrive_folder_id` | (empty) | Target Google Drive folder ID (or leave empty for root My Drive). |
| `qbx_backup_gdrive_keep` | `0` | Number of backups to keep in Google Drive folder (0 disables count pruning). |
| `qbx_backup_gdrive_max_age_days` | `0` | Delete Google Drive backups older than this many days (0 disables age pruning). |
| `qbx_backup_gdrive_keep_local` | `0` | Also retain local zip copy when uploading to Google Drive. |
| `qbx_db_backup_s3_bucket` | (empty) | S3 bucket name. |
| `qbx_db_backup_s3_key` | (empty) | S3 Access Key ID (or `qbx_db_backup_s3_access_key_id`). |
| `qbx_db_backup_s3_secret` | (empty) | S3 Secret Access Key (or `qbx_db_backup_s3_secret_access_key`). |
| `qbx_db_backup_s3_endpoint` | (empty) | Custom S3 endpoint URL (e.g. for Cloudflare R2, Wasabi, MinIO). |
| `qbx_db_backup_s3_region` | `us-east-1` | S3 region (`auto` for Cloudflare R2). |
| `qbx_db_backup_s3_prefix` | (empty) | Prefix path inside the bucket (e.g. `backups/`). |
| `qbx_db_backup_s3_keep` | `0` | Number of backups to keep in the S3 bucket prefix (0 disables count pruning). |
| `qbx_db_backup_s3_max_age_days` | `0` | Delete S3 backups older than this many days (0 disables age pruning). |
| `qbx_db_backup_zip_level` | `6` | Compression level, 1 (fastest) to 9 (smallest). |
| `qbx_db_backup_timeout_minutes` | `120` | Give up on a backup after this long. |
| `qbx_db_backup_dump_bin` | (empty) | Path to your own `mariadb-dump` or `mysqldump` instead of the bundled one. |

## Notes

- The database user needs `SELECT`, `SHOW VIEW` and `TRIGGER`. With `EVENT` and routine access the
  backup also includes events and stored routines; without them it still succeeds and says so.
- Only one backup runs at a time.
- If your server restricts convars with `add_convar_permission`, also add
  `add_convar_permission qbx_db_backup read mysql_connection_string`.
- Windows x64 and Linux x64 use the bundled `mariadb-dump`. On other platforms the resource looks
  for `mariadb-dump` or `mysqldump` on `PATH`, or uses `qbx_db_backup_dump_bin`.

## Bundled mariadb-dump

`bin/` contains the unmodified `mariadb-dump` client from MariaDB 11.8.9, licensed under the
GNU GPL v2. See [`bin/UPSTREAM.md`](bin/UPSTREAM.md) for where it came from and
[`bin/LICENSE.GPLv2`](bin/LICENSE.GPLv2) for the license.

## License

MIT