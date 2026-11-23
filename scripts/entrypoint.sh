#!/bin/sh
# The data and backup folders may be mounted from the host (owned by root);
# fix their owner, then run the app as the unprivileged "node" user.
chown -R node:node /data /backups 2>/dev/null || true
exec su-exec node "$@"
