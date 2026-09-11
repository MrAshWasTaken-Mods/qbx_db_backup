# Google Drive Backup Setup Guide (100% Free)

`qbx_db_backup` supports automated streaming backups directly to **Google Drive** using the official Google Drive API v3. This setup is **100% free** and utilizes your personal Google account's **15 GB free storage** (or Google Workspace / Shared Drives) with zero ongoing API costs or credit card requirements.

---

## 3-Minute Setup Walkthrough

### Step 1: Create a Free Project in Google Cloud Console
1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Click the project dropdown in the top bar and select **New Project**.
3. Name your project (e.g. `FiveM Database Backups`) and click **Create**.
4. Make sure your newly created project is selected.

---

### Step 2: Enable Google Drive API (Free)
1. In the search bar at the top, type **Google Drive API** and click on it.
2. Click **Enable**.
*(This is 100% free with a generous quota of 20,000 queries per 100 seconds).*

---

### Step 3: Configure the OAuth Consent Screen
1. In the left navigation menu, go to **APIs & Services** ➔ **OAuth consent screen**.
2. Choose **External** (or **Internal** if using Google Workspace) and click **Create**.
3. Enter an **App name** (e.g. `Qbox DB Backup`) and your support email.
4. Click **Save and Continue** through the Scopes and Test Users steps.
5. In the **Test users** section, add your own Google email address.
6. Click **Save and Continue**.

---

### Step 4: Create OAuth 2.0 Credentials
1. In the left menu, click **Credentials** ➔ **Create Credentials** ➔ **OAuth client ID**.
2. Set **Application type** to **Desktop app** (or **Web application**).
3. Name it (e.g. `FiveM Server`) and click **Create**.
4. Copy your **Client ID** and **Client Secret**.

---

### Step 5: Obtain Your 1-Time Refresh Token

You can generate your non-expiring `refresh_token` in 30 seconds using the [Google OAuth 2.0 Playground](https://developers.google.com/oauthplayground):

1. Go to [Google OAuth 2.0 Playground](https://developers.google.com/oauthplayground).
2. In the top right corner, click the **Gear icon (OAuth 2.0 configuration)**:
   - Check **Use your own OAuth credentials**.
   - Paste your **OAuth Client ID** and **OAuth Client Secret** from Step 4.
3. On the left side, under **Step 1: Select & authorize APIs**:
   - Scroll down to **Drive API v3** and select `https://www.googleapis.com/auth/drive`.
4. Click **Authorize APIs** and log in with your Google account (click *Advanced ➔ Go to Qbox DB Backup (unsafe)* if warned).
5. On the left side under **Step 2: Exchange authorization code for tokens**:
   - Click **Exchange authorization code for tokens**.
6. Copy the resulting **Refresh token** (starts with `1//04...`).

---

### Step 6: (Optional) Create a Dedicated Folder in Google Drive
1. Open your [Google Drive](https://drive.google.com).
2. Create a new folder named `FiveM Backups`.
3. Open the folder and look at the browser URL:
   `https://drive.google.com/drive/folders/1A2B3C4D5E6F7G8H9...`
4. The long alphanumeric string after `/folders/` is your **Folder ID**.

---

## Convar Configuration in `server.cfg`

Add the following to your `server.cfg`:

```lua
# ========================================================
# Google Drive Backup Configuration (100% Free)
# ========================================================
set qbx_backup_destination "gdrive"

# OAuth 2.0 Credentials
set qbx_backup_gdrive_client_id "1234567890-abcdef.apps.googleusercontent.com"
set qbx_backup_gdrive_client_secret "GOCSPX-yourClientSecret"
set qbx_backup_gdrive_refresh_token "1//04yourRefreshToken"

# Target Folder ID (or omit / set to "root" for top-level My Drive)
set qbx_backup_gdrive_folder_id "1A2B3C4D5E6F7G8H9..."

# Retention Policy
set qbx_backup_gdrive_keep "14"          # Keep latest 14 backups in Google Drive
set qbx_backup_gdrive_max_age_days "30"  # Prune backups older than 30 days

# Optional: Dual-write local zip copy
set qbx_backup_gdrive_keep_local "true"
```

---

## Verifying the Connection

In your FiveM server console (or live server terminal), run:

```text
qbx_db_backup test
```

Expected output:
```text
[INFO] database: parsed 127.0.0.1:3306/qbox_db (ssl=false)
[INFO] dump binary: mysqldump (10.11.6-MariaDB) [bundled]
[INFO] testing Google Drive storage (folder: "FiveM Backups")...
[INFO] Google Drive connected successfully (folder: "FiveM Backups", storage used: 1.2 GB / 15.0 GB)
```

To run a manual test backup immediately:
```text
qbx_db_backup run
```
