#!/bin/sh
# docker-entrypoint.sh — runs as root on container start, fixes up volume
# ownership, then drops to the `klebb` user and execs the CMD.
#
# Why: the /data volume is commonly a bind-mount owned by the host user
# (typically UID 1000). The container's runtime user is klebb (UID 1001),
# so without this entrypoint it can't create credentials/, sessions/, etc.,
# and WebAuthn registration fails on first use.
#
# Idempotent: re-runs chown on every start; cheap, and means an operator
# can drop new files onto the host volume without worrying about ownership.

set -eu

DATA_DIR="${HEALTH_HOME:-/data}"
RUN_UID="${PUID:-1001}"
RUN_GID="${PGID:-1001}"
RUN_USER="klebb"

# If we're not root, we can't chown — just exec straight through. This
# branch covers users who override --user on the `docker run` invocation.
if [ "$(id -u)" != "0" ]; then
    exec "$@"
fi

# Make sure the volume root + standard subdirs exist. The app's
# ensureWritableDirs() also does this, but doing it here means the chown
# below covers everything in one pass.
mkdir -p \
    "$DATA_DIR" \
    "$DATA_DIR/data" \
    "$DATA_DIR/credentials" \
    "$DATA_DIR/sessions" \
    "$DATA_DIR/reports"

# Fail loudly if the volume isn't writable by root (e.g. read-only mount).
if ! touch "$DATA_DIR/.klebb-entrypoint-probe" 2>/dev/null; then
    echo "[entrypoint] FATAL: $DATA_DIR is not writable by root." >&2
    echo "[entrypoint] Check the volume mount — is it read-only?" >&2
    exit 1
fi
rm -f "$DATA_DIR/.klebb-entrypoint-probe"

# chown the volume tree to the runtime user. Quiet on stdout, errors to stderr.
chown -R "$RUN_UID:$RUN_GID" "$DATA_DIR"

# Drop privileges to the runtime user and exec the real command. Using
# `exec` keeps tini as PID 1 and ensures signals propagate cleanly to Node.
exec gosu "$RUN_USER" "$@"
