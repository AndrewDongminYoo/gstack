# gstack-profile (per-project skill curation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make gstack skills opt-in per project — a project with no `.gstack/profile.yaml` gets no gstack skills; a profile materializes exactly the enabled subset into the project's `.claude/skills/`.

**Architecture:** The gstack checkout is the global superset and the symlink source. Skills are no longer linked into `~/.claude/skills/`. A new `bin/gstack-profile` (bun TS) reads `.gstack/profile.yaml` and reconciles `<project>/.claude/skills/gstack-*` symlinks against it. The gate is symlink presence/absence — no `permissions`/`skillOverrides` (deny-beats-allow makes those unusable for opt-in). `setup` gains a persisted `skill_install_mode` so per-project mode skips global linking and cleans up any prior global install; `/gstack-upgrade` honors the mode so it never re-globalizes.

**Tech Stack:** Bun (TS bins, `bun:test`), bash (`setup`, `gstack-config`), Node `fs` for symlinks. No new dependencies — the fixed-shape YAML profile is hand-parsed.

## Global Constraints

- No new runtime dependencies. The profile YAML is a fixed subset (`version`, `skills.enabled`), hand-parsed; do NOT add a yaml library.
- Cross-platform: every symlink-or-copy must mirror `setup`'s `_link_or_copy` semantics (symlink on Unix, copy on Windows). Detect Windows via `process.platform === "win32"`.
- Default `skill_install_mode` is `global` (preserves existing installs). This fork sets `per-project`; never change the default to `per-project`.
- Skill link naming honors the existing `skill_prefix` config exactly: `gstack-<name>` when `true`, `<name>` when `false`. Resolve it the same way `setup`/`gstack-relink` do.
- Source-of-truth skill enumeration matches `setup`'s `link_claude_skill_dirs`: a directory is a skill iff it contains `SKILL.md`; skip `node_modules`; the link name comes from the `name:` frontmatter field (fallback to dir name).
- All shell additions to `setup` must keep `shellcheck` clean and route every link through `_link_or_copy` (enforced by `test/setup-windows-fallback.test.ts`).
- `bin/gstack-profile` must work when invoked through a PATH symlink — resolve the checkout via its own real module path, overridable by `GSTACK_PROFILE_SOURCE_DIR` for tests.

---

### Task 1: Add `skill_install_mode` config key

**Files:**

- Modify: `bin/gstack-config` (DEFAULTS table `lookup_default()`, ~line 119; CONFIG_HEADER comment block ~line 58-83)
- Test: `test/docs-config-keys.test.ts` (existing — confirm it covers the new key) and `test/gstack-profile-config.test.ts` (new)

**Interfaces:**

- Produces: config key `skill_install_mode` with values `global` | `per-project`, default `global`. Read via `gstack-config get skill_install_mode`; set via `gstack-config set skill_install_mode per-project`.

- [ ] **Step 1: Write the failing test**

Create `test/gstack-profile-config.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const ROOT = path.resolve(import.meta.dir, "..");
const CONFIG = path.join(ROOT, "bin", "gstack-config");

function runConfig(args: string[], home: string) {
  return spawnSync(CONFIG, args, {
    encoding: "utf-8",
    env: { ...process.env, GSTACK_HOME: home },
  });
}

describe("skill_install_mode config key", () => {
  test("defaults to 'global' when unset", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "gsk-cfg-"));
    try {
      const r = runConfig(["get", "skill_install_mode"], home);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("global");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("round-trips 'per-project'", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "gsk-cfg-"));
    try {
      runConfig(["set", "skill_install_mode", "per-project"], home);
      const r = runConfig(["get", "skill_install_mode"], home);
      expect(r.stdout.trim()).toBe("per-project");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/gstack-profile-config.test.ts`
Expected: FAIL — `get skill_install_mode` returns empty string (default not yet registered).

- [ ] **Step 3: Add the default**

In `bin/gstack-config`, inside `lookup_default()` add a case alongside `skill_prefix`:

```bash
	skill_install_mode) echo "global" ;; # global | per-project — per-project = opt-in skills via gstack-profile
```

And add to the CONFIG_HEADER comment block (near the `skill_prefix` doc comment):

```bash
# skill_install_mode: global   # global = link all skills into ~/.claude/skills (default)
#                              # per-project = opt-in; use gstack-profile per repo
```

If `test/docs-config-keys.test.ts` enforces a header comment for every DEFAULTS key, the comment above satisfies it; run it in Step 4.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/gstack-profile-config.test.ts test/docs-config-keys.test.ts`
Expected: PASS (both files).

- [ ] **Step 5: Commit**

```bash
git add bin/gstack-config test/gstack-profile-config.test.ts
git commit -m "feat(config): add skill_install_mode key (global|per-project)"
```

---

### Task 2: `gstack-profile` skeleton — source resolution, superset enumeration, `list`

**Files:**

- Create: `bin/gstack-profile` (bun TS, executable)
- Test: `test/gstack-profile.test.ts` (new)

**Interfaces:**

- Produces (module-internal, used by later tasks):
  - `resolveSourceDir(): string` — checkout root; `GSTACK_PROFILE_SOURCE_DIR` overrides, else `path.resolve(import.meta.dir, "..")`.
  - `enumerateSuperset(sourceDir: string): {dir: string, name: string}[]` — skill dirs with `SKILL.md`, `name` from frontmatter (fallback dir name), `node_modules` skipped.
  - `skillPrefix(sourceDir: string): boolean` — reads `gstack-config get skill_prefix`.
  - `linkName(name: string, prefix: boolean): string` — `gstack-<name>` if prefix and not already prefixed, else `name`.
  - `findProjectRoot(start: string): string` — walk up to the dir containing `.git` or `.gstack`, else `start`.
  - CLI: `gstack-profile list` prints one line per superset skill, `[x]`/`[ ]` for enabled-in-this-project, sorted by name.

- [ ] **Step 1: Write the failing test**

Create `test/gstack-profile.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const ROOT = path.resolve(import.meta.dir, "..");
const BIN = path.join(ROOT, "bin", "gstack-profile");

// Build a fake source checkout with three skills + a fake gstack-config.
function makeSource(): string {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "gsk-src-"));
  for (const [dir, name] of [
    ["ship", "ship"],
    ["review", "review"],
    ["investigate", "investigate"],
  ]) {
    fs.mkdirSync(path.join(src, dir), { recursive: true });
    fs.writeFileSync(
      path.join(src, dir, "SKILL.md"),
      `---\nname: ${name}\n---\nbody\n`,
    );
  }
  fs.mkdirSync(path.join(src, "node_modules", "junk"), { recursive: true });
  fs.writeFileSync(
    path.join(src, "node_modules", "junk", "SKILL.md"),
    `---\nname: junk\n---\n`,
  );
  // fake gstack-config that always reports skill_prefix=false
  fs.mkdirSync(path.join(src, "bin"));
  fs.writeFileSync(
    path.join(src, "bin", "gstack-config"),
    `#!/usr/bin/env bash\n[ "$1" = "get" ] && [ "$2" = "skill_prefix" ] && echo false\n`,
  );
  fs.chmodSync(path.join(src, "bin", "gstack-config"), 0o755);
  return src;
}

function run(args: string[], cwd: string, src: string) {
  return spawnSync(BIN, args, {
    encoding: "utf-8",
    cwd,
    env: { ...process.env, GSTACK_PROFILE_SOURCE_DIR: src },
  });
}

describe("gstack-profile list", () => {
  test("lists the superset, all unchecked when no profile", () => {
    const src = makeSource();
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "gsk-proj-"));
    try {
      const r = run(["list"], proj, src);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("[ ] investigate");
      expect(r.stdout).toContain("[ ] review");
      expect(r.stdout).toContain("[ ] ship");
      expect(r.stdout).not.toContain("junk"); // node_modules skipped
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/gstack-profile.test.ts`
Expected: FAIL — `bin/gstack-profile` does not exist (ENOENT / non-zero status).

- [ ] **Step 3: Write minimal implementation**

Create `bin/gstack-profile` (then `chmod +x`):

```typescript
#!/usr/bin/env bun
/**
 * gstack-profile — per-project skill curation (opt-in).
 * Reads .gstack/profile.yaml and reconciles <project>/.claude/skills/gstack-*
 * symlinks against the enabled list. The gstack checkout is the symlink source.
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const IS_WINDOWS = process.platform === "win32";

export function resolveSourceDir(): string {
  const override = process.env.GSTACK_PROFILE_SOURCE_DIR;
  if (override) return override;
  return path.resolve(import.meta.dir, "..");
}

export function enumerateSuperset(
  sourceDir: string,
): { dir: string; name: string }[] {
  const out: { dir: string; name: string }[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(sourceDir);
  } catch {
    return out;
  }
  for (const dir of entries) {
    if (dir === "node_modules") continue;
    const skillMd = path.join(sourceDir, dir, "SKILL.md");
    if (!fs.existsSync(skillMd)) continue;
    let name = dir;
    try {
      const text = fs.readFileSync(skillMd, "utf-8");
      const m = text.match(/^name:\s*(.+)$/m);
      if (m) name = m[1].trim();
    } catch {}
    out.push({ dir, name });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function skillPrefix(sourceDir: string): boolean {
  const cfg = path.join(sourceDir, "bin", "gstack-config");
  try {
    const r = spawnSync(cfg, ["get", "skill_prefix"], { encoding: "utf-8" });
    return r.stdout.trim() === "true";
  } catch {
    return false;
  }
}

export function linkName(name: string, prefix: boolean): string {
  if (!prefix) return name;
  return name.startsWith("gstack-") ? name : `gstack-${name}`;
}

export function findProjectRoot(start: string): string {
  let dir = path.resolve(start);
  while (true) {
    if (
      fs.existsSync(path.join(dir, ".git")) ||
      fs.existsSync(path.join(dir, ".gstack"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

function cmdList(): number {
  const source = resolveSourceDir();
  const projectRoot = findProjectRoot(process.cwd());
  const enabled = new Set(readProfileEnabled(projectRoot)); // defined in Task 3; empty until then
  for (const { name } of enumerateSuperset(source)) {
    const mark = enabled.has(name) ? "x" : " ";
    console.log(`[${mark}] ${name}`);
  }
  return 0;
}

// Placeholder until Task 3 implements real parsing. Keeps `list` working now.
export function readProfileEnabled(_projectRoot: string): string[] {
  return [];
}

function main(): number {
  const [cmd] = process.argv.slice(2);
  switch (cmd) {
    case "list":
      return cmdList();
    default:
      console.error(
        "Usage: gstack-profile {list|status|init|enable|disable|sync|off|doctor}",
      );
      return 1;
  }
}

if (import.meta.main) process.exit(main());
```

Then make it executable:

```bash
chmod +x bin/gstack-profile
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/gstack-profile.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bin/gstack-profile test/gstack-profile.test.ts
git commit -m "feat(profile): gstack-profile skeleton with superset list"
```

---

### Task 3: Profile parsing + `sync` reconcile + `status`

**Files:**

- Modify: `bin/gstack-profile` (replace `readProfileEnabled`, add `materialize`, `reconcile`, `isGstackManaged`, `cmdSync`, `cmdStatus`, route `sync`/`status`)
- Test: `test/gstack-profile.test.ts` (add cases)

**Interfaces:**

- Consumes: `resolveSourceDir`, `enumerateSuperset`, `skillPrefix`, `linkName`, `findProjectRoot` from Task 2.
- Produces:
  - `readProfileEnabled(projectRoot): string[]` — parses `<projectRoot>/.gstack/profile.yaml`, returns the `skills.enabled` list items. Missing file → `[]`. Unknown-shape lines ignored. Throws `ProfileError` on an `enabled` entry not in the superset (caller prints + lists superset).
  - `cmdSync()` — materializes exactly the enabled skills as `<projectRoot>/.claude/skills/<linkName>/SKILL.md` symlinks (+ `sections/`), removes any gstack-managed link not in the enabled set. Idempotent. Returns 0.
  - `cmdStatus()` — prints enabled (from profile) vs materialized (on disk), flags drift.

- [ ] **Step 1: Write the failing tests**

Add to `test/gstack-profile.test.ts`:

```typescript
function writeProfile(projectRoot: string, enabled: string[]) {
  fs.mkdirSync(path.join(projectRoot, ".gstack"), { recursive: true });
  const body = `version: 1\nskills:\n  enabled:\n${enabled.map((s) => `    - ${s}`).join("\n")}\n`;
  fs.writeFileSync(path.join(projectRoot, ".gstack", "profile.yaml"), body);
}

function materialized(projectRoot: string): string[] {
  const dir = path.join(projectRoot, ".claude", "skills");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}

describe("gstack-profile sync", () => {
  test("materializes exactly the enabled skills", () => {
    const src = makeSource();
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "gsk-proj-"));
    try {
      writeProfile(proj, ["ship", "review"]);
      const r = run(["sync"], proj, src);
      expect(r.status).toBe(0);
      expect(materialized(proj)).toEqual(["review", "ship"]);
      // symlink points into the source checkout
      const target = fs.readlinkSync(
        path.join(proj, ".claude", "skills", "ship", "SKILL.md"),
      );
      expect(target).toBe(path.join(src, "ship", "SKILL.md"));
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });

  test("is idempotent and removes skills dropped from the profile", () => {
    const src = makeSource();
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "gsk-proj-"));
    try {
      writeProfile(proj, ["ship", "review"]);
      run(["sync"], proj, src);
      run(["sync"], proj, src); // twice — no error, no dupes
      expect(materialized(proj)).toEqual(["review", "ship"]);
      writeProfile(proj, ["ship"]); // drop review
      run(["sync"], proj, src);
      expect(materialized(proj)).toEqual(["ship"]);
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });

  test("errors on an enabled skill not in the superset", () => {
    const src = makeSource();
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "gsk-proj-"));
    try {
      writeProfile(proj, ["nonesuch"]);
      const r = run(["sync"], proj, src);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("nonesuch");
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/gstack-profile.test.ts`
Expected: FAIL — `sync` is unrouted (usage error, status 1) and materializes nothing.

- [ ] **Step 3: Write the implementation**

In `bin/gstack-profile`, replace the placeholder `readProfileEnabled` and add the new functions. Replace:

```typescript
// Placeholder until Task 3 implements real parsing. Keeps `list` working now.
export function readProfileEnabled(_projectRoot: string): string[] {
  return [];
}
```

with:

```typescript
export class ProfileError extends Error {}

/** Parse the fixed-shape profile: version + skills.enabled list. No yaml dep. */
export function readProfileEnabled(projectRoot: string): string[] {
  const file = path.join(projectRoot, ".gstack", "profile.yaml");
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf-8").split("\n");
  const enabled: string[] = [];
  let inSkills = false;
  let inEnabled = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^\S/.test(line)) {
      inSkills = /^skills:\s*$/.test(line);
      inEnabled = false;
      continue;
    }
    if (inSkills && /^\s{2}enabled:\s*$/.test(line)) {
      inEnabled = true;
      continue;
    }
    if (inSkills && /^\s{2}\w/.test(line)) {
      inEnabled = false; // a sibling key under skills:
      continue;
    }
    if (inEnabled) {
      const m = line.match(/^\s{4,}-\s*(\S+)\s*$/);
      if (m) enabled.push(m[1]);
    }
  }
  return enabled;
}

/** A project skill dir is gstack-managed if its SKILL.md symlink points into the source checkout. */
function isGstackManaged(skillDir: string, sourceDir: string): boolean {
  const md = path.join(skillDir, "SKILL.md");
  try {
    const st = fs.lstatSync(md);
    if (st.isSymbolicLink()) {
      const target = fs.readlinkSync(md);
      const resolved = path.resolve(path.dirname(md), target);
      return resolved.startsWith(path.resolve(sourceDir) + path.sep);
    }
  } catch {}
  // Windows copy fallback: a .gstack-managed marker file written at materialize time.
  return fs.existsSync(path.join(skillDir, ".gstack-managed"));
}

function linkOrCopy(src: string, dst: string) {
  if (fs.existsSync(dst) || isSymlink(dst))
    fs.rmSync(dst, { recursive: true, force: true });
  if (IS_WINDOWS) {
    const st = fs.statSync(src);
    if (st.isDirectory()) fs.cpSync(src, dst, { recursive: true });
    else fs.copyFileSync(src, dst);
  } else {
    fs.symlinkSync(src, dst);
  }
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function materialize(
  sourceDir: string,
  projectRoot: string,
  dir: string,
  name: string,
  prefix: boolean,
) {
  const link = linkName(name, prefix);
  const target = path.join(projectRoot, ".claude", "skills", link);
  fs.mkdirSync(target, { recursive: true });
  linkOrCopy(
    path.join(sourceDir, dir, "SKILL.md"),
    path.join(target, "SKILL.md"),
  );
  const sections = path.join(sourceDir, dir, "sections");
  if (fs.existsSync(sections))
    linkOrCopy(sections, path.join(target, "sections"));
  if (IS_WINDOWS) fs.writeFileSync(path.join(target, ".gstack-managed"), "");
}

function reconcile(
  sourceDir: string,
  projectRoot: string,
): { added: string[]; removed: string[] } {
  const prefix = skillPrefix(sourceDir);
  const superset = enumerateSuperset(sourceDir);
  const supersetByName = new Map(superset.map((s) => [s.name, s]));
  const enabled = readProfileEnabled(projectRoot);

  // Validate first — fail before mutating anything.
  for (const name of enabled) {
    if (!supersetByName.has(name)) {
      throw new ProfileError(
        `Unknown skill "${name}" in .gstack/profile.yaml. Run 'gstack-profile list' to see valid skills.`,
      );
    }
  }

  const wantLinks = new Set(enabled.map((n) => linkName(n, prefix)));
  const added: string[] = [];
  const removed: string[] = [];

  for (const name of enabled) {
    const s = supersetByName.get(name)!;
    materialize(sourceDir, projectRoot, s.dir, s.name, prefix);
    added.push(linkName(name, prefix));
  }

  const skillsDir = path.join(projectRoot, ".claude", "skills");
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir)) {
      const full = path.join(skillsDir, entry);
      if (wantLinks.has(entry)) continue;
      if (isGstackManaged(full, sourceDir)) {
        fs.rmSync(full, { recursive: true, force: true });
        removed.push(entry);
      }
    }
  }
  return { added, removed };
}

function cmdSync(): number {
  const source = resolveSourceDir();
  const projectRoot = findProjectRoot(process.cwd());
  try {
    const { added, removed } = reconcile(source, projectRoot);
    console.log(`synced: ${added.length} enabled, ${removed.length} removed`);
    return 0;
  } catch (err) {
    if (err instanceof ProfileError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
}

function cmdStatus(): number {
  const source = resolveSourceDir();
  const projectRoot = findProjectRoot(process.cwd());
  const prefix = skillPrefix(source);
  const enabled = readProfileEnabled(projectRoot);
  const wantLinks = new Set(enabled.map((n) => linkName(n, prefix)));
  const skillsDir = path.join(projectRoot, ".claude", "skills");
  const onDisk = new Set(
    fs.existsSync(skillsDir)
      ? fs
          .readdirSync(skillsDir)
          .filter((e) => isGstackManaged(path.join(skillsDir, e), source))
      : [],
  );
  console.log(`project: ${projectRoot}`);
  console.log(
    `enabled in profile: ${enabled.length ? enabled.join(", ") : "(none)"}`,
  );
  for (const link of new Set([...wantLinks, ...onDisk])) {
    const want = wantLinks.has(link);
    const have = onDisk.has(link);
    const flag =
      want && have ? "ok" : want ? "MISSING (run sync)" : "STALE (run sync)";
    console.log(`  ${link}: ${flag}`);
  }
  return 0;
}
```

Then update the router `switch` in `main()` to add:

```typescript
    case "sync":
      return cmdSync();
    case "status":
      return cmdStatus();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/gstack-profile.test.ts`
Expected: PASS (all `list` + `sync` cases).

- [ ] **Step 5: Commit**

```bash
git add bin/gstack-profile test/gstack-profile.test.ts
git commit -m "feat(profile): profile parsing, sync reconcile, status"
```

---

### Task 4: `init`, `enable`, `disable`, `off`

**Files:**

- Modify: `bin/gstack-profile` (add `cmdInit`, `cmdEnable`, `cmdDisable`, `cmdOff`, `writeProfile`, `.gitignore` management; route new commands)
- Test: `test/gstack-profile.test.ts` (add cases)

**Interfaces:**

- Consumes: everything from Tasks 2-3.
- Produces:
  - `cmdInit(all: boolean)` — creates `.gstack/profile.yaml` (empty enabled, or all superset names if `all`); appends `.claude/skills/gstack-*` and `.claude/skills/*` managed entries to `<projectRoot>/.gitignore` once.
  - `cmdEnable(names)` / `cmdDisable(names)` — edit the profile's enabled list (validated against superset for enable), then run `reconcile`.
  - `cmdOff()` — remove every gstack-managed link from the project; leave the profile file intact.

- [ ] **Step 1: Write the failing tests**

Add to `test/gstack-profile.test.ts`:

```typescript
function readEnabled(projectRoot: string): string[] {
  const f = path.join(projectRoot, ".gstack", "profile.yaml");
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, "utf-8")
    .split("\n")
    .map((l) => l.match(/^\s{4,}-\s*(\S+)/))
    .filter(Boolean)
    .map((m) => (m as RegExpMatchArray)[1]);
}

describe("gstack-profile init/enable/disable/off", () => {
  test("init scaffolds an empty profile and gitignore entry", () => {
    const src = makeSource();
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "gsk-proj-"));
    try {
      fs.mkdirSync(path.join(proj, ".git")); // mark project root
      const r = run(["init"], proj, src);
      expect(r.status).toBe(0);
      expect(fs.existsSync(path.join(proj, ".gstack", "profile.yaml"))).toBe(
        true,
      );
      expect(fs.readFileSync(path.join(proj, ".gitignore"), "utf-8")).toContain(
        ".claude/skills",
      );
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });

  test("enable adds to profile and materializes; disable reverses", () => {
    const src = makeSource();
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "gsk-proj-"));
    try {
      fs.mkdirSync(path.join(proj, ".git"));
      run(["init"], proj, src);
      run(["enable", "ship", "review"], proj, src);
      expect(readEnabled(proj).sort()).toEqual(["review", "ship"]);
      expect(materialized(proj)).toEqual(["review", "ship"]);
      run(["disable", "review"], proj, src);
      expect(readEnabled(proj)).toEqual(["ship"]);
      expect(materialized(proj)).toEqual(["ship"]);
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });

  test("off removes all managed links, keeps the profile", () => {
    const src = makeSource();
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "gsk-proj-"));
    try {
      fs.mkdirSync(path.join(proj, ".git"));
      run(["init"], proj, src);
      run(["enable", "ship"], proj, src);
      run(["off"], proj, src);
      expect(materialized(proj)).toEqual([]);
      expect(fs.existsSync(path.join(proj, ".gstack", "profile.yaml"))).toBe(
        true,
      );
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });

  test("enable rejects an unknown skill", () => {
    const src = makeSource();
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "gsk-proj-"));
    try {
      fs.mkdirSync(path.join(proj, ".git"));
      run(["init"], proj, src);
      const r = run(["enable", "bogus"], proj, src);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("bogus");
      expect(readEnabled(proj)).toEqual([]);
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/gstack-profile.test.ts`
Expected: FAIL — `init`/`enable`/`disable`/`off` unrouted.

- [ ] **Step 3: Write the implementation**

Add to `bin/gstack-profile`:

```typescript
function writeProfile(projectRoot: string, enabled: string[]) {
  const dir = path.join(projectRoot, ".gstack");
  fs.mkdirSync(dir, { recursive: true });
  const body =
    `version: 1\nskills:\n  enabled:\n` +
    (enabled.length ? enabled.map((s) => `    - ${s}`).join("\n") + "\n" : "");
  fs.writeFileSync(path.join(dir, "profile.yaml"), body);
}

function ensureGitignore(projectRoot: string) {
  const gi = path.join(projectRoot, ".gitignore");
  const marker = ".claude/skills";
  const existing = fs.existsSync(gi) ? fs.readFileSync(gi, "utf-8") : "";
  if (existing.split("\n").some((l) => l.trim() === marker)) return;
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(
    gi,
    `${prefix}# gstack-profile materialized skills (managed, not committed)\n${marker}\n`,
  );
}

function cmdInit(all: boolean): number {
  const source = resolveSourceDir();
  const projectRoot = findProjectRoot(process.cwd());
  const enabled = all ? enumerateSuperset(source).map((s) => s.name) : [];
  writeProfile(projectRoot, enabled);
  ensureGitignore(projectRoot);
  console.log(
    `initialized .gstack/profile.yaml (${enabled.length} skills enabled)`,
  );
  if (all) cmdSync();
  return 0;
}

function editEnabled(
  projectRoot: string,
  mutate: (set: Set<string>) => void,
): string[] {
  const set = new Set(readProfileEnabled(projectRoot));
  mutate(set);
  const next = [...set].sort();
  writeProfile(projectRoot, next);
  return next;
}

function cmdEnable(names: string[]): number {
  const source = resolveSourceDir();
  const projectRoot = findProjectRoot(process.cwd());
  const supersetNames = new Set(enumerateSuperset(source).map((s) => s.name));
  for (const n of names) {
    if (!supersetNames.has(n)) {
      console.error(
        `Unknown skill "${n}". Run 'gstack-profile list' to see valid skills.`,
      );
      return 2;
    }
  }
  editEnabled(projectRoot, (set) => names.forEach((n) => set.add(n)));
  return cmdSync();
}

function cmdDisable(names: string[]): number {
  const projectRoot = findProjectRoot(process.cwd());
  editEnabled(projectRoot, (set) => names.forEach((n) => set.delete(n)));
  return cmdSync();
}

function cmdOff(): number {
  const source = resolveSourceDir();
  const projectRoot = findProjectRoot(process.cwd());
  const skillsDir = path.join(projectRoot, ".claude", "skills");
  let removed = 0;
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir)) {
      const full = path.join(skillsDir, entry);
      if (isGstackManaged(full, source)) {
        fs.rmSync(full, { recursive: true, force: true });
        removed++;
      }
    }
  }
  console.log(`removed ${removed} gstack skill link(s); profile kept`);
  return 0;
}
```

Update the router in `main()`:

```typescript
    case "init":
      return cmdInit(process.argv.includes("--all"));
    case "enable":
      return cmdEnable(process.argv.slice(3).filter((a) => !a.startsWith("-")));
    case "disable":
      return cmdDisable(process.argv.slice(3).filter((a) => !a.startsWith("-")));
    case "off":
      return cmdOff();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/gstack-profile.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add bin/gstack-profile test/gstack-profile.test.ts
git commit -m "feat(profile): init/enable/disable/off commands"
```

---

### Task 5: `setup` per-project mode (skip global linking + clean up)

**Files:**

- Modify: `setup` (resolve `skill_install_mode` near the `SKILL_PREFIX` resolution ~line 142-181; gate the `link_claude_skill_dirs`/`link_claude_root_skill_alias`/connect-chrome block ~line 1025-1052 on the mode; add `--opt-in`/`--global` flags ~line 88-99)
- Test: `test/gstack-profile-setup-mode.test.ts` (new — static + behavioral)

**Interfaces:**

- Consumes: `skill_install_mode` config (Task 1).
- Produces: when mode is `per-project`, `setup` does NOT call `link_claude_skill_dirs`/`link_claude_root_skill_alias`, removes any existing `~/.claude/skills/gstack-*` + `_gstack-command` via the existing cleanup helpers, and prints a one-line "per-project mode — use gstack-profile" note. `--opt-in` sets the mode to `per-project` and persists it; `--global` sets `global`.

- [ ] **Step 1: Write the failing test**

Create `test/gstack-profile-setup-mode.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import * as path from "path";
import * as fs from "fs";

const ROOT = path.resolve(import.meta.dir, "..");
const SETUP_SRC = fs.readFileSync(path.join(ROOT, "setup"), "utf-8");

describe("setup: per-project skill_install_mode", () => {
  test("parses --opt-in and --global flags", () => {
    expect(SETUP_SRC).toContain("--opt-in");
    expect(SETUP_SRC).toContain("--global");
  });

  test("resolves skill_install_mode from config", () => {
    expect(SETUP_SRC).toContain("skill_install_mode");
  });

  test("gates global skill linking on the mode", () => {
    // The link calls must be inside a conditional that references the mode var,
    // not unconditional. Assert the guard token sits before the link call.
    const guardIdx = SETUP_SRC.indexOf("SKILL_INSTALL_MODE");
    const linkIdx = SETUP_SRC.indexOf(
      'link_claude_skill_dirs "$SOURCE_GSTACK_DIR" "$INSTALL_SKILLS_DIR"',
    );
    expect(guardIdx).toBeGreaterThan(0);
    expect(linkIdx).toBeGreaterThan(guardIdx);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/gstack-profile-setup-mode.test.ts`
Expected: FAIL — no `--opt-in`/`SKILL_INSTALL_MODE` tokens in `setup` yet.

- [ ] **Step 3: Implement in `setup`**

3a. In the flag-parsing `while` loop (alongside `--prefix`/`--no-prefix`), add:

```bash
    --opt-in)  SKILL_INSTALL_MODE_FLAG="per-project"; shift ;;
    --global)  SKILL_INSTALL_MODE_FLAG="global"; shift ;;
```

And initialize near the other flag defaults (~line 80):

```bash
SKILL_INSTALL_MODE_FLAG=""   # "" = resolve from config; else explicit
```

3b. After the `SKILL_PREFIX` resolution block (~line 181), resolve the mode and persist an explicit flag:

```bash
# ─── Resolve skill install mode ───────────────────────────────
# global = link all skills into ~/.claude/skills (default, legacy behavior)
# per-project = opt-in; skills are materialized per repo by gstack-profile
if [ -n "$SKILL_INSTALL_MODE_FLAG" ]; then
  SKILL_INSTALL_MODE="$SKILL_INSTALL_MODE_FLAG"
  "$GSTACK_CONFIG" set skill_install_mode "$SKILL_INSTALL_MODE" 2>/dev/null || true
else
  SKILL_INSTALL_MODE="$("$GSTACK_CONFIG" get skill_install_mode 2>/dev/null || echo global)"
fi
[ "$SKILL_INSTALL_MODE" = "per-project" ] || SKILL_INSTALL_MODE="global"
```

3c. In the Claude install block (~line 1026, inside `if [ "$SKILLS_BASENAME" = "skills" ]`), wrap the linking in the mode guard. Replace the body that currently runs cleanup + `gstack-patch-names` + `link_claude_skill_dirs` + `link_claude_root_skill_alias` + connect-chrome with:

```bash
		if [ "$SKILL_INSTALL_MODE" = "per-project" ]; then
			# Opt-in mode: never link skills globally. Remove any prior global
			# install so leftovers don't leak into every project.
			cleanup_old_claude_symlinks "$SOURCE_GSTACK_DIR" "$INSTALL_SKILLS_DIR"
			cleanup_prefixed_claude_symlinks "$SOURCE_GSTACK_DIR" "$INSTALL_SKILLS_DIR"
			rm -rf "$INSTALL_SKILLS_DIR/_gstack-command"
			# connect-chrome alias is a global skill too — drop both name variants.
			rm -rf "$INSTALL_SKILLS_DIR/connect-chrome" "$INSTALL_SKILLS_DIR/gstack-connect-chrome"
			log "gstack ready (per-project / opt-in)."
			log "  enable skills per repo: gstack-profile init && gstack-profile enable <skill>"
		else
			# Clean up stale symlinks from the opposite prefix mode
			if [ "$SKILL_PREFIX" -eq 1 ]; then
				cleanup_old_claude_symlinks "$SOURCE_GSTACK_DIR" "$INSTALL_SKILLS_DIR"
			else
				cleanup_prefixed_claude_symlinks "$SOURCE_GSTACK_DIR" "$INSTALL_SKILLS_DIR"
			fi
			"$SOURCE_GSTACK_DIR/bin/gstack-patch-names" "$SOURCE_GSTACK_DIR" "$SKILL_PREFIX"
			link_claude_skill_dirs "$SOURCE_GSTACK_DIR" "$INSTALL_SKILLS_DIR"
			link_claude_root_skill_alias "$SOURCE_GSTACK_DIR" "$INSTALL_SKILLS_DIR"
			GSTACK_RELINK="$SOURCE_GSTACK_DIR/bin/gstack-relink"
			if [ -x "$GSTACK_RELINK" ]; then
				GSTACK_SKILLS_DIR="$INSTALL_SKILLS_DIR" GSTACK_INSTALL_DIR="$SOURCE_GSTACK_DIR" "$GSTACK_RELINK" >/dev/null 2>&1 || true
			fi
			_OGB_LINK="$INSTALL_SKILLS_DIR/connect-chrome"
			if [ "$SKILL_PREFIX" -eq 1 ]; then
				_OGB_LINK="$INSTALL_SKILLS_DIR/gstack-connect-chrome"
			fi
			if [ -L "$_OGB_LINK" ] || [ ! -e "$_OGB_LINK" ]; then
				_link_or_copy "gstack/open-gstack-browser" "$_OGB_LINK"
			fi
			if [ "$LOCAL_INSTALL" -eq 1 ]; then
				log "gstack ready (project-local)."
				log "  skills: $INSTALL_SKILLS_DIR"
			else
				log "gstack ready (claude)."
			fi
		fi
		log "  browse: $BROWSE_BIN"
```

(Keep the binary build, playwright, and `~/.gstack` steps above this block unchanged — only the skill-linking is gated.)

- [ ] **Step 4: Run tests + shellcheck**

Run: `bun test test/gstack-profile-setup-mode.test.ts test/setup-windows-fallback.test.ts && shellcheck setup`
Expected: PASS, and shellcheck clean.

- [ ] **Step 5: Commit**

```bash
git add setup test/gstack-profile-setup-mode.test.ts
git commit -m "feat(setup): per-project skill_install_mode skips global linking"
```

---

### Task 6: `gstack-profile doctor` + best-effort PATH symlink

**Files:**

- Modify: `bin/gstack-profile` (add `cmdDoctor`, route `doctor`)
- Modify: `setup` (per-project branch: best-effort symlink `gstack-profile` into `~/.local/bin` if that dir is on PATH)
- Test: `test/gstack-profile.test.ts` (add doctor case)

**Interfaces:**

- Consumes: `resolveSourceDir`.
- Produces: `cmdDoctor()` — exits 0 with "clean" when no global gstack skills exist under `~/.claude/skills/`; exits 0 with a WARNING listing leftover `gstack-*` / `_gstack-command` dirs that would leak into opt-in. Honors `GSTACK_PROFILE_CLAUDE_SKILLS` env override (for tests) instead of `~/.claude/skills`.

- [ ] **Step 1: Write the failing test**

Add to `test/gstack-profile.test.ts`:

```typescript
describe("gstack-profile doctor", () => {
  test("warns about a leftover global install", () => {
    const src = makeSource();
    const fakeClaude = fs.mkdtempSync(path.join(os.tmpdir(), "gsk-claude-"));
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "gsk-proj-"));
    try {
      fs.mkdirSync(path.join(fakeClaude, "gstack-ship"), { recursive: true });
      const r = spawnSync(BIN, ["doctor"], {
        encoding: "utf-8",
        cwd: proj,
        env: {
          ...process.env,
          GSTACK_PROFILE_SOURCE_DIR: src,
          GSTACK_PROFILE_CLAUDE_SKILLS: fakeClaude,
        },
      });
      expect(r.status).toBe(0);
      expect(r.stdout + r.stderr).toContain("gstack-ship");
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
      fs.rmSync(fakeClaude, { recursive: true, force: true });
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });

  test("reports clean when no global gstack skills exist", () => {
    const src = makeSource();
    const fakeClaude = fs.mkdtempSync(path.join(os.tmpdir(), "gsk-claude-"));
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "gsk-proj-"));
    try {
      const r = spawnSync(BIN, ["doctor"], {
        encoding: "utf-8",
        cwd: proj,
        env: {
          ...process.env,
          GSTACK_PROFILE_SOURCE_DIR: src,
          GSTACK_PROFILE_CLAUDE_SKILLS: fakeClaude,
        },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("clean");
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
      fs.rmSync(fakeClaude, { recursive: true, force: true });
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/gstack-profile.test.ts`
Expected: FAIL — `doctor` unrouted.

- [ ] **Step 3: Implement**

Add to `bin/gstack-profile`:

```typescript
function cmdDoctor(): number {
  const claudeSkills =
    process.env.GSTACK_PROFILE_CLAUDE_SKILLS ||
    path.join(process.env.HOME || "", ".claude", "skills");
  const leftovers: string[] = [];
  if (fs.existsSync(claudeSkills)) {
    for (const entry of fs.readdirSync(claudeSkills)) {
      if (
        entry.startsWith("gstack-") ||
        entry === "_gstack-command" ||
        entry === "connect-chrome"
      ) {
        leftovers.push(entry);
      }
    }
  }
  if (leftovers.length === 0) {
    console.log(
      "doctor: clean — no global gstack skills found. Opt-in is intact.",
    );
    return 0;
  }
  console.warn(
    `doctor: WARNING — ${leftovers.length} global gstack skill(s) under ${claudeSkills} will leak into every project:`,
  );
  for (const l of leftovers.sort()) console.warn(`  ${l}`);
  console.warn("Fix: re-run './setup --opt-in' to remove the global install.");
  return 0;
}
```

Route in `main()`:

```typescript
    case "doctor":
      return cmdDoctor();
```

3b. In `setup`'s per-project branch (Task 5, after the cleanup), add a best-effort launcher symlink:

```bash
			# Best-effort: expose gstack-profile on PATH if ~/.local/bin is used.
			if printf '%s' ":$PATH:" | grep -q ":$HOME/.local/bin:"; then
				mkdir -p "$HOME/.local/bin"
				_link_or_copy "$SOURCE_GSTACK_DIR/bin/gstack-profile" "$HOME/.local/bin/gstack-profile"
			else
				log "  tip: add gstack-profile to PATH or run it via $SOURCE_GSTACK_DIR/bin/gstack-profile"
			fi
```

- [ ] **Step 4: Run tests + shellcheck**

Run: `bun test test/gstack-profile.test.ts && shellcheck setup`
Expected: PASS, shellcheck clean.

- [ ] **Step 5: Commit**

```bash
git add bin/gstack-profile setup test/gstack-profile.test.ts
git commit -m "feat(profile): doctor command + best-effort PATH launcher"
```

---

### Task 7: `/gstack-upgrade` honors the mode + migration note

**Files:**

- Modify: `gstack-upgrade/SKILL.md.tmpl` (or the upgrade script it calls) — ensure the post-upgrade `./setup` invocation does NOT pass `--global` and relies on persisted config
- Create: `gstack-upgrade/migrations/<NNN>-skill-install-mode.sh` (or the repo's migration format — read `CONTRIBUTING.md` "Upgrade migrations")
- Test: `test/gstack-profile-upgrade.test.ts` (new — static assertion that upgrade does not force `--global`)

**Interfaces:**

- Consumes: persisted `skill_install_mode` (Tasks 1, 5).
- Produces: upgrading a per-project install stays per-project (setup reads config, no override). A migration that, for installs already on `per-project`, removes any stale global gstack skill dirs left by a pre-feature version.

- [ ] **Step 1: Read the migration format**

Run: `sed -n '/Upgrade migrations/,/^## /p' CONTRIBUTING.md` and read `gstack-upgrade/migrations/` for an existing example. Mirror its shape (idempotent, guarded, logs what it changed).

- [ ] **Step 2: Write the failing test**

Create `test/gstack-profile-upgrade.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import * as path from "path";
import * as fs from "fs";

const ROOT = path.resolve(import.meta.dir, "..");

describe("gstack-upgrade respects skill_install_mode", () => {
  test("upgrade does not force --global on setup", () => {
    // Whatever file drives the post-upgrade setup run must not hardcode --global.
    const candidates = [
      "gstack-upgrade/SKILL.md.tmpl",
      "gstack-upgrade/SKILL.md",
    ];
    const present = candidates.filter((c) => fs.existsSync(path.join(ROOT, c)));
    expect(present.length).toBeGreaterThan(0);
    for (const c of present) {
      const txt = fs.readFileSync(path.join(ROOT, c), "utf-8");
      expect(txt).not.toContain("./setup --global");
      expect(txt).not.toContain("setup --global");
    }
  });
});
```

- [ ] **Step 3: Run test to verify it passes or fails**

Run: `bun test test/gstack-profile-upgrade.test.ts`
Expected: If upgrade never passed `--global`, this PASSES immediately (guard test). If it FAILS, remove the `--global` from the upgrade flow so setup reads persisted config.

- [ ] **Step 4: Write the migration**

Create `gstack-upgrade/migrations/<NNN>-skill-install-mode.sh` mirroring the existing format. Logic (idempotent):

```bash
#!/usr/bin/env bash
# Migration: for installs already on per-project mode, remove any stale global
# gstack skill dirs left by a pre-gstack-profile version.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$SCRIPT_DIR/../../bin/gstack-config"
MODE="$("$CONFIG" get skill_install_mode 2>/dev/null || echo global)"
[ "$MODE" = "per-project" ] || { echo "skill-install-mode: global mode, nothing to migrate"; exit 0; }
SKILLS="$HOME/.claude/skills"
removed=0
for entry in "$SKILLS"/gstack-* "$SKILLS/_gstack-command" "$SKILLS/connect-chrome"; do
  [ -e "$entry" ] || continue
  rm -rf "$entry"
  removed=$((removed + 1))
done
echo "skill-install-mode: removed $removed stale global gstack skill dir(s)"
```

Adjust the path math and filename number to match the existing migrations directory.

- [ ] **Step 5: Run tests + shellcheck + commit**

Run: `bun test test/gstack-profile-upgrade.test.ts && shellcheck gstack-upgrade/migrations/*.sh`
Expected: PASS, shellcheck clean.

```bash
git add gstack-upgrade test/gstack-profile-upgrade.test.ts
git commit -m "feat(upgrade): honor skill_install_mode; migrate stale global skills"
```

---

### Task 8: Docs — README + CLAUDE.md note + run full test suite

**Files:**

- Modify: `README.md` (a short "Per-project skills (opt-in)" section near team-mode instructions)
- Modify: `docs/designs/GSTACK_PROFILE_V0.md` (flip Status to "implemented")
- Test: full `bun test`

**Interfaces:** none (docs + verification).

- [ ] **Step 1: Add README section**

Document: `./setup --opt-in` switches to per-project mode; in a repo run `gstack-profile init` then `gstack-profile enable <skill>`; `gstack-profile list/status/sync/off/doctor`. Commit `.gstack/profile.yaml`; `.claude/skills/` is gitignored. Match the spec's trunk framing.

- [ ] **Step 2: Run the full free test suite**

Run: `bun test`
Expected: PASS (all existing tests + the new `gstack-profile*` files). Investigate any failure before proceeding.

- [ ] **Step 3: Flip the spec status + commit**

```bash
git add README.md docs/designs/GSTACK_PROFILE_V0.md
git commit -m "docs(profile): document per-project opt-in skills"
```

---

## Self-Review

**Spec coverage:**

- Opt-in default → Tasks 1, 5 (per-project mode, no global linking).
- Symlink materialization gate → Tasks 3, 4 (`sync`/`enable` materialize, `off`/`disable` remove).
- `.gstack/profile.yaml` format → Task 3 (`readProfileEnabled`), Task 4 (`writeProfile`).
- CLI `init/list/status/enable/disable/sync/off/doctor` → Tasks 2 (list), 3 (sync/status), 4 (init/enable/disable/off), 6 (doctor).
- Source resolution via own path + env override → Task 2 (`resolveSourceDir`).
- skill_prefix-aware naming → Task 2 (`linkName`/`skillPrefix`), used in Task 3.
- Global-install rework (skip link, clean up, no re-globalize) → Tasks 5, 7.
- Testing (reconcile, idempotency, prefix, source resolution, tripwire) → Tasks 2-7 tests.
- Windows symlink-or-copy → `linkOrCopy` in Task 3, `_link_or_copy` reuse in setup.

**Placeholder scan:** Task 7 intentionally defers to `CONTRIBUTING.md`'s migration format and the existing migrations dir (filename number, path math) because that format is the repo's source of truth — Step 1 reads it before writing. All other steps contain complete code.

**Type consistency:** `readProfileEnabled`, `enumerateSuperset`, `linkName`, `skillPrefix`, `resolveSourceDir`, `findProjectRoot`, `isGstackManaged`, `materialize`, `reconcile`, `ProfileError` are named identically across Tasks 2-6. `GSTACK_PROFILE_SOURCE_DIR` and `GSTACK_PROFILE_CLAUDE_SKILLS` env overrides are used consistently in bin and tests.

**Known follow-ups (not blocking):** the Task 2 skeleton ships a placeholder `readProfileEnabled` that returns `[]` so `list` works before Task 3; Task 3 replaces it. This is an intentional incremental seam, not a placeholder-in-the-plan.
