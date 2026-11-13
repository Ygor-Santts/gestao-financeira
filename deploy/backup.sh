#!/bin/sh
# Daily copy of the database, kept for 14 days. Run from ~/financas on the server:
#   0 4 * * * cd ~/financas && sh deploy/backup.sh >> backups/backup.log 2>&1
set -eu
cd "$(dirname "$0")/.."
mkdir -p backups
DAY=$(date +%F)
dc() { docker compose -f docker-compose.server.yml "$@"; }
# VACUUM INTO writes a consistent copy even while the app is running.
dc exec -T financas node --disable-warning=ExperimentalWarning -e "
  const { DatabaseSync } = require('node:sqlite');
  const fs = require('node:fs');
  try { fs.unlinkSync('/data/backup.db'); } catch {}
  new DatabaseSync('/data/financas.db').exec(\"VACUUM INTO '/data/backup.db'\");
"
dc cp financas:/data/backup.db "backups/financas-$DAY.db"
gzip -f "backups/financas-$DAY.db"
find backups -name 'financas-*.db.gz' -mtime +14 -delete
echo "Backup ok: backups/financas-$DAY.db.gz"
