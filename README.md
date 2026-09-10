# qbx_db_backup

Backs up your FiveM server's MySQL/MariaDB database from inside the server. The dump runs on the
machine itself, so the database never has to be reachable from the internet and your credentials
never leave it.

- **Standalone**: run a backup from the console and the zip lands next to the resource.
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
| `qbx_db_backup run` | Back up now. Standalone: writes the zip to `resources/qbx_db_backup/backups/`. Connected: uploads to the dashboard or S3. |
| `qbx_db_backup status` | Shows the current mode, target database, schedule, and the last result. |
| `qbx_db_backup test` | Checks the configuration without touching the database. |
| `qbx_db_backup version` | Prints the version. |

To connect the resource to the Qbox dashboard, paste the token from your organisation's backup
settings:

```cfg
set qbx_db_backup_token "your-token"
```

Backups then show up in the dashboard with their history and alerts. Use `set`, never `setr`:
`setr` would send the value to every connected player.

In all modes a backup runs automatically every `qbx_db_backup_interval_hours` hours (hourly by
default), and `qbx_db_backup run` in the server console is how you start one by hand. Backups are
always started on the server itself, never from the dashboard. When connected to the dashboard, at
most one backup per hour is accepted and the dashboard keeps as many backups as your plan's storage
allows, deleting the oldest automatically.

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
| `qbx_db_backup_token` | (empty) | Dashboard token. Leave empty to run standalone or with S3. |
| `qbx_db_backup_connection_string` | (empty) | Use different credentials than the server does. Same formats as oxmysql. |
| `qbx_db_backup_interval_hours` | `1` | How often to back up, in hours. Minimum 1, 0 disables the schedule. Manual runs always work. |
| `qbx_db_backup_local_keep` | `7` | How many zips to keep in the local folder (standalone, or connected with `keep_local`). |
| `qbx_db_backup_local_max_age_days` | `0` | Delete local backups older than this many days (0 disables age pruning). |
| `qbx_db_backup_min_free_disk_mb` | `0` | Minimum free disk space in MB. Prunes oldest local zips if drive space drops below this. |
| `qbx_db_backup_keep_local` | `0` | When uploading to S3 or dashboard, also keep a copy of each zip in the local folder. |
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

MIT. The bundled `mariadb-dump` is GPLv2 (see above).

## Building from source

`dist/` is committed, so a clone runs as is. To rebuild after changing `src/`:

```sh
bun install
bun run build
bun test
```
