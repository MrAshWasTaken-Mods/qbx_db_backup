# Bundled mariadb-dump

Unmodified `mariadb-dump` client binaries from the official MariaDB 11.8.9 (LTS) release,
extracted from the archives below. MariaDB client programs are licensed under the GNU GPL v2
(see LICENSE.GPLv2); source code is available from https://github.com/MariaDB/server/tree/mariadb-11.8.9
and https://downloads.mariadb.org/mariadb/11.8.9/.

| Platform | Archive | Extracted member |
| --- | --- | --- |
| win64 | https://archive.mariadb.org/mariadb-11.8.9/winx64-packages/mariadb-11.8.9-winx64.zip | mariadb-11.8.9-winx64/bin/mariadb-dump.exe |
| linux-x64 | https://archive.mariadb.org/mariadb-11.8.9/bintar-linux-systemd-x86_64/mariadb-11.8.9-linux-systemd-x86_64.tar.gz | mariadb-11.8.9-linux-systemd-x86_64/bin/mariadb-dump |

Upstream `sha256sums.txt` entries the archives were verified against before extraction:

```
830c46727d9278eae212ae3eca44eeb9e71b2a68704e95f344a64fba7b1963f5  ./mariadb-11.8.9-winx64.zip
32f8871a2aa38b36aa418b7f4abc6fc0c6ef1ba5a45798cacb2afa52c8a6113b  mariadb-11.8.9-linux-systemd-x86_64.tar.gz
```

Checksums of the extracted binaries are in SHA256SUMS (`sha256sum -c SHA256SUMS` from this directory).

Runtime requirements verified on 2026-09-06: the Linux binary links only glibc (>= 2.31 tested on
Ubuntu 20.04 and Debian 12) and libstdc++; the Windows binary needs the Microsoft VC++ runtime
that FXServer itself already requires.

## Updating

1. Download the `winx64-packages` zip and the `bintar-linux-systemd-x86_64` tarball for the new
   version from https://archive.mariadb.org/ and verify each against the `sha256sums.txt` in the
   same directory.
2. Extract `bin/mariadb-dump.exe` and `bin/mariadb-dump` and replace the files here.
3. `sha256sum -b win64/mariadb-dump.exe linux-x64/mariadb-dump > SHA256SUMS`
4. Update the table and checksum block above, and re-check the runtime requirements.
