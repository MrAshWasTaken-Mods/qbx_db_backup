# qbx_db_backup

Backs up your FiveM server's MySQL/MariaDB database from inside the server. The dump runs on the
machine itself, so the database never has to be reachable from the internet and your credentials
never leave it.

- **Standalone**: run a backup from the console and the zip lands next to the resource.
- **With the QBox dashboard**: scheduled, off-site backups with history and alerts.
- **Nothing to install**: `mariadb-dump` is bundled for Windows and Linux (x64).

## Install

1. Clone or download this repository into `resources/qbx_db_backup`.
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
| `qbx_db_backup run` | Back up now. Standalone: writes the zip to `resources/qbx_db_backup/backups/`. Connected: uploads it to the dashboard. |
| `qbx_db_backup status` | Shows the current mode, target database, schedule, and the last result. |
| `qbx_db_backup test` | Checks the configuration without touching the database. |
| `qbx_db_backup version` | Prints the version. |

To connect the resource to the QBox dashboard, paste the token from your organisation's backup
settings:

```cfg
set qbx_db_backup_token "your-token"
```

Backups then show up in the dashboard with their history and alerts; `qbx_db_backup run` still
works for an immediate one. Use `set`, never `setr`: `setr` would send the value to every
connected player.

In both modes a backup runs automatically every `qbx_db_backup_interval_hours` hours (daily by
default). When connected to the dashboard, at most one backup per hour is accepted and the
dashboard keeps as many backups as your plan's storage allows, deleting the oldest automatically.

## Configuration

Everything has a working default. The resource reads the database credentials from the
`mysql_connection_string` convar your database resource already uses.

| Convar | Default | Meaning |
| --- | --- | --- |
| `qbx_db_backup_token` | (empty) | Dashboard token. Leave empty to run standalone. |
| `qbx_db_backup_connection_string` | (empty) | Use different credentials than the server does. Same formats as oxmysql. |
| `qbx_db_backup_interval_hours` | `24` | How often to back up, in hours. Minimum 1, 0 disables the schedule. Manual runs always work. |
| `qbx_db_backup_local_keep` | `7` | How many zips to keep in the local folder (standalone, or connected with `keep_local`). |
| `qbx_db_backup_keep_local` | `0` | When connected, also keep a copy of each zip in the local folder. |
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

## Building from source

`dist/` is committed, so a clone runs as is. To rebuild after changing `src/`:

```sh
pnpm install
pnpm build
pnpm test
```
