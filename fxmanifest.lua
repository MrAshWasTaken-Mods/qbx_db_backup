fx_version 'cerulean'
game 'common'

name 'qbx_db_backup'
author 'Qbox'
description 'Local database backups for the Qbox dashboard'
version '1.0.0'
license 'MIT'
repository 'https://github.com/Qbox-project/qbx_db_backup'

dependency '/server:12913'

server_only 'yes'
server_script 'dist/server.js'
