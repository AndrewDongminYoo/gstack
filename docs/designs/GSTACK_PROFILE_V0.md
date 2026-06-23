# GSTACK_PROFILE_V0 — per-project skill curation (trunk-style, opt-in)

Status: design (approved direction, pending implementation plan)
Date: 2026-06-24
Scope: this fork only (not an upstream contribution)

## Problem

gstack installs every skill globally into `~/.claude/skills/` (via `setup`'s
`link_claude_skills`), so `/ship`, `/review`, `/office-hours`, and ~40 others are
visible in every project and every session.
The full superset is not wanted everywhere.
We want gstack to behave like trunk.io: a global superset that each project opts
into, enabling only the subset it needs.

## Decisions (locked)

1. **Opt-in by default.** A project with no profile gets no gstack skills at all.
   This mirrors trunk: no `.trunk/` means trunk does nothing.
2. **Mechanism: per-project symlink materialization (not a settings gate).**
   The gate is the presence or absence of a skill symlink under the project's
   `.claude/skills/`.
   We do NOT use `permissions.deny` or `skillOverrides`.
3. **The superset source is the gstack checkout itself.**
   The checkout stays present globally (bins on PATH, the launcher); its skill
   directories are the symlink source. They are no longer linked into
   `~/.claude/skills/`.

### Why not the settings-deny gate (the original Approach A)

Approach A keeps the global install and writes `permissions.deny` per project to
trim the superset.
That works for opt-out, but not for opt-in.
The Claude Code permissions docs are explicit: **deny beats allow across all
tiers** ("if a tool is denied at any level, no other level can allow it").
A global `permissions.deny: ["Skill(gstack-*)"]` plus a project
`permissions.allow` cannot re-enable a skill, so global-off + project-on is
impossible.
`skillOverrides` per-project layering is undocumented and offers no glob, so it is
not a reliable foundation either.
Materialization sidesteps precedence entirely: project-level
`.claude/skills/<name>/SKILL.md` is natively discovered, and absence means absent.

## Architecture

### The model

```text
gstack checkout (superset, global)
  ├── ship/SKILL.md
  ├── review/SKILL.md
  └── ... (~40 skill dirs)         <- symlink SOURCE, never linked into ~/.claude/skills
                │
                │  gstack-profile sync  (reads .gstack/profile.yaml)
                ▼
<project>/.claude/skills/
  ├── gstack-ship/SKILL.md     -> <checkout>/ship/SKILL.md
  └── gstack-review/SKILL.md   -> <checkout>/review/SKILL.md   (only enabled skills)
```

trunk parallel: linter binaries live in a global cache, `.trunk/trunk.yaml` (committed)
selects a subset, the tool materializes that subset for the project.
Here the checkout is the cache, `.gstack/profile.yaml` is the config, the symlinks
are the materialized subset.

### Profile file — `.gstack/profile.yaml`

Committed to the project repo (team-shareable, like `.trunk/trunk.yaml`).

```yaml
version: 1
skills:
  enabled:
    - ship
    - review
    - investigate
```

- Names are each skill's canonical `name:` (flat, no `gstack-` prefix in the file).
  The `gstack-` prefix is an install detail applied at materialize time, honoring
  the `skill_prefix` config.
- Opt-in is allowlist-native, so MVP supports `enabled` only.
  No `disabled` list (nothing is on by default, so there is nothing to subtract).
- An unknown skill name is an error that prints the valid superset.

### CLI — `bin/gstack-profile`

| Command              | Behavior                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `init [--all]`       | Scaffold `.gstack/profile.yaml` (empty, or all skills). Ensure the project `.gitignore` ignores `.claude/skills/gstack-*`.  |
| `list`               | Print the full superset (skill dirs in the checkout), marking which are enabled in this project.                            |
| `status`             | Show this project's profile vs reality: which symlinks are materialized, and any drift.                                     |
| `enable <skill...>`  | Add to the profile's `enabled` list, then `sync`.                                                                           |
| `disable <skill...>` | Remove from `enabled`, then `sync`.                                                                                         |
| `sync`               | Reconcile `.claude/skills/gstack-*` to exactly match the profile (create missing, remove extra). Idempotent.                |
| `off`                | Remove all gstack-managed symlinks from this project (profile file stays).                                                  |
| `doctor`             | Warn if `~/.claude/skills/gstack-*` exists globally (it would leak into every project and defeat opt-in); point to cleanup. |

### Source resolution

`gstack-profile` resolves its own real path (`readlink -f "$0"`, the way `setup`
uses `pwd -P`) to find the checkout root, then enumerates skill directories the
same way `link_claude_skills` does (a directory is a skill if it contains
`SKILL.md`).
No new config key is required.
It reads `skill_prefix` to name the project-side link (`gstack-ship` vs `ship`)
and links `sections/` alongside `SKILL.md` for carved skills, matching `setup`.

### The global-install rework (the core work)

Opt-in lives or dies here.
If `~/.claude/skills/gstack-*` survives, those leftovers show in every project and
only same-named project links override them, so every other global skill still
leaks.
Three pieces, all required:

1. **`setup` gains a per-project mode.**
   A persisted `skill_install_mode` config (`global` | `per-project`), set by
   `setup --opt-in` (or `gstack-config set skill_install_mode per-project`).
   Default stays `global` to preserve existing installs; this fork sets
   `per-project`.
   In `per-project` mode, `setup` builds binaries and links bins onto PATH and the
   `gstack-profile` launcher, but does NOT call `link_claude_skills` into
   `~/.claude/skills/`, and does not install the global `_gstack-command`.
2. **Cleanup of an existing global install.**
   Entering `per-project` mode removes existing `~/.claude/skills/gstack-*`
   prefixed dirs and `_gstack-command`, reusing `setup`'s existing
   `cleanup_*_claude_symlinks` helpers.
   `gstack-profile doctor` reports leftovers if cleanup was skipped.
3. **`/gstack-upgrade` must not re-globalize.**
   Upgrade runs `./setup`; `setup` must honor the persisted `skill_install_mode`
   so an upgrade stays opt-in.
   Add a `gstack-upgrade/migrations/` entry if the on-disk state needs adjusting
   for existing installs.

## Testing (gate tier — deterministic, free)

A bun test under `test/`:

- Profile parse: `enabled` list read correctly; unknown skill name errors and
  lists the superset.
- `sync` reconcile: materializes exactly the enabled skills; removes symlinks not
  in the profile.
- Idempotency: `sync` twice produces no diff.
- Prefix naming: link names follow `skill_prefix` on and off.
- Source resolution works when `gstack-profile` is invoked through a PATH symlink.
- Static tripwire: in `per-project` mode, `setup` writes nothing under
  `~/.claude/skills/gstack-*`.

Classify `gate` (deterministic functional). No paid eval needed.

## Out of scope (YAGNI)

- Preset bundles (design / review / ship groups) — add later if the explicit
  `enabled` list proves tedious.
- Interactive TUI for picking skills.
- Auto-sync watcher on profile edit.
- Gating third-party (non-gstack) skills.
- Coexisting opt-out mode — opt-in is the chosen default; opt-out is a possible
  later mode behind the same `skill_install_mode` config.

## Risks

- **Leftover global install defeats opt-in.** Mitigated by the cleanup step and
  `doctor`. This is the highest-risk item.
- **Upgrade re-globalizes.** Mitigated by persisting `skill_install_mode` and
  honoring it in `setup`.
- **Windows symlink staleness.** `setup` already routes links through
  `_link_or_copy` (copies on Windows, stale after `git pull`); `gstack-profile`
  reuses that helper and inherits the same "re-run after pull" note.
