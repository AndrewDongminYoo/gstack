#!/usr/bin/env bash
# Migration: v1.59.0.0 — remove stale global gstack skill dirs for per-project installs
#
# Why a migration: gstack v1.59 adds per-project skill install mode
# (skill_install_mode=per-project). Users who upgraded from a global install
# and then switched to per-project mode still have stale global skill dirs
# under ~/.claude/skills/ (gstack-*, _gstack-command, connect-chrome) left by
# the old installer. These directories are now unused and should be removed to
# keep ~/.claude/skills/ clean.
#
# Affected: users who previously ran a global gstack install (./setup or
# ./setup --global) and have since set skill_install_mode=per-project.
#
# Scope guard: only acts when skill_install_mode=per-project; exits immediately
# for any other value (global or unset).
#
# Idempotent: removal of non-existent paths is a no-op.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG_BIN="${SCRIPT_DIR}/bin/gstack-config"

MODE="$("${CONFIG_BIN}" get skill_install_mode 2>/dev/null || echo global)"

if [ "${MODE}" != "per-project" ]; then
	echo "  [v1.59.0.0] skill-install-mode: ${MODE} — nothing to migrate" >&2
	exit 0
fi

SKILLS="${HOME}/.claude/skills"
removed=0

for entry in "${SKILLS}"/gstack-* "${SKILLS}/_gstack-command" "${SKILLS}/connect-chrome"; do
	[ -e "${entry}" ] || continue
	rm -rf "${entry}"
	removed=$((removed + 1))
	echo "  [v1.59.0.0] Removed stale global skill dir: ${entry}" >&2
done

echo "  [v1.59.0.0] skill-install-mode migration complete: removed ${removed} stale global gstack skill dir(s)" >&2
exit 0
