# S3 Provider Configuration Examples

`qbx_db_backup` supports any S3-compatible object storage provider. Add the convars for your provider to your `server.cfg` (after `mysql_connection_string`).

Always use `set`, never `setr`: `setr` would broadcast your credentials to connected players.

---

## Cloudflare R2

```cfg
set qbx_db_backup_s3_endpoint "https://<account_id>.r2.cloudflarestorage.com"
set qbx_db_backup_s3_region "auto"
set qbx_db_backup_s3_bucket "my-r2-bucket"
set qbx_db_backup_s3_key "your-r2-access-key-id"
set qbx_db_backup_s3_secret "your-r2-secret-access-key"
```

---

## AWS S3

```cfg
set qbx_db_backup_s3_region "us-east-1"
set qbx_db_backup_s3_bucket "my-aws-bucket"
set qbx_db_backup_s3_key "AKIAIOSFODNN7EXAMPLE"
set qbx_db_backup_s3_secret "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
```

---

## Wasabi

```cfg
set qbx_db_backup_s3_endpoint "https://s3.wasabisys.com"
set qbx_db_backup_s3_region "us-east-1"
set qbx_db_backup_s3_bucket "my-wasabi-bucket"
set qbx_db_backup_s3_key "your-wasabi-access-key"
set qbx_db_backup_s3_secret "your-wasabi-secret-key"
```

---

## Backblaze B2 (S3-Compatible API)

```cfg
set qbx_db_backup_s3_endpoint "https://s3.us-west-004.backblazeb2.com"
set qbx_db_backup_s3_region "us-west-004"
set qbx_db_backup_s3_bucket "my-b2-bucket"
set qbx_db_backup_s3_key "your-key-id"
set qbx_db_backup_s3_secret "your-application-key"
```

---

## MinIO / Local S3

```cfg
set qbx_db_backup_s3_endpoint "http://127.0.0.1:9000"
set qbx_db_backup_s3_bucket "my-minio-bucket"
set qbx_db_backup_s3_key "minioadmin"
set qbx_db_backup_s3_secret "minioadmin"
set qbx_db_backup_s3_force_path_style 1
```

---

## DigitalOcean Spaces

```cfg
set qbx_db_backup_s3_endpoint "https://nyc3.digitaloceanspaces.com"
set qbx_db_backup_s3_region "nyc3"
set qbx_db_backup_s3_bucket "my-space-name"
set qbx_db_backup_s3_key "your-spaces-key"
set qbx_db_backup_s3_secret "your-spaces-secret"
```

---

## Optional Prefix & Retention

You can organize backups inside a folder prefix and automatically prune older backups:

```cfg
# Store inside a prefix/folder
set qbx_db_backup_s3_prefix "fivem-prod/"

# Keep the newest 30 backups in the bucket
set qbx_db_backup_s3_keep 30

# Or delete backups older than 60 days (0 to disable)
set qbx_db_backup_s3_max_age_days 60
```
