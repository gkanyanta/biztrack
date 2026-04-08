#!/bin/bash
# BizTrack Database Backup Script
# Usage: ./scripts/backup-database.sh [database_url]
#
# Can be run manually or via cron/GitHub Actions.
# Keeps the last 30 daily backups and rotates old ones.

set -euo pipefail

# Configuration
BACKUP_DIR="${BACKUP_DIR:-$(dirname "$0")/../backups}"
DATABASE_URL="${1:-${DATABASE_URL:-}}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")
BACKUP_FILE="$BACKUP_DIR/biztrack_backup_${TIMESTAMP}.sql.gz"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[BACKUP]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }

# Validate
if [ -z "$DATABASE_URL" ]; then
  error "DATABASE_URL is required. Pass as argument or set as environment variable."
  echo "Usage: $0 <database_url>"
  exit 1
fi

# Find the highest version of pg_dump available
PG_DUMP=""
for ver in 17 16 15 14; do
  if [ -x "/usr/lib/postgresql/${ver}/bin/pg_dump" ]; then
    PG_DUMP="/usr/lib/postgresql/${ver}/bin/pg_dump"
    break
  fi
done
if [ -z "$PG_DUMP" ]; then
  if command -v pg_dump &> /dev/null; then
    PG_DUMP="pg_dump"
  else
    error "pg_dump not found. Install postgresql-client-17."
    exit 1
  fi
fi

# Create backup directory
mkdir -p "$BACKUP_DIR"

log "Starting backup at $(date)"
log "Using: $PG_DUMP"

# Run backup (compressed with gzip)
if $PG_DUMP --no-sync "$DATABASE_URL" \
  --format=plain \
  --no-owner \
  --no-privileges \
  --clean \
  --if-exists | gzip > "$BACKUP_FILE"; then

  FILESIZE=$(du -h "$BACKUP_FILE" | cut -f1)
  log "Backup completed: $BACKUP_FILE ($FILESIZE)"
else
  error "Backup failed!"
  rm -f "$BACKUP_FILE"
  exit 1
fi

# Verify backup is not empty
if [ ! -s "$BACKUP_FILE" ]; then
  error "Backup file is empty. Something went wrong."
  rm -f "$BACKUP_FILE"
  exit 1
fi

# Rotate old backups
log "Removing backups older than $RETENTION_DAYS days..."
DELETED=$(find "$BACKUP_DIR" -name "biztrack_backup_*.sql.gz" -mtime +$RETENTION_DAYS -delete -print | wc -l)
if [ "$DELETED" -gt 0 ]; then
  log "Deleted $DELETED old backup(s)."
fi

# Summary
TOTAL_BACKUPS=$(find "$BACKUP_DIR" -name "biztrack_backup_*.sql.gz" | wc -l)
TOTAL_SIZE=$(du -sh "$BACKUP_DIR" | cut -f1)
log "Total backups: $TOTAL_BACKUPS ($TOTAL_SIZE)"
log "Done."
