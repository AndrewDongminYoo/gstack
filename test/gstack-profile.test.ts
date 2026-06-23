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

describe("findProjectRoot — $HOME leak guard", () => {
  // Regression: without the home-guard, walking up from a non-git subdirectory
  // would resolve to $HOME when ~/.gstack (the state dir) exists there. That
  // caused 'init' to write profile.yaml into ~/.gstack and materialize skills
  // into ~/.claude/skills — the exact global leak opt-in must prevent.
  //
  // RED reasoning (no code revert needed): without the `dir !== home` guard,
  // the walk from <tmpHome>/work/proj would match <tmpHome> because
  // <tmpHome>/.gstack exists, returning <tmpHome> as projectRoot. The test
  // asserts profile is at proj, not tmpHome — which fails. GREEN: the guard
  // skips <tmpHome>, walk reaches filesystem root, falls back to start.
  //
  // Note: Bun honors HOME env override via os.homedir() (verified: `HOME=/tmp/x
  // bun -e 'console.log(require("os").homedir())'` → /tmp/x), so the HOME
  // override in spawnSync env correctly redirects findProjectRoot's homedir call.
  test("does not resolve project root to $HOME even when ~/.gstack exists", () => {
    const src = makeSource();
    // Build a fake home tree outside the gstack repo (never under a real .git)
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gsk-home-"));
    const proj = path.join(tmpHome, "work", "proj");
    fs.mkdirSync(proj, { recursive: true });
    // Mimic the ~/.gstack state dir that always exists on a configured machine
    fs.mkdirSync(path.join(tmpHome, ".gstack"), { recursive: true });
    try {
      const r = spawnSync(BIN, ["init"], {
        encoding: "utf-8",
        cwd: proj,
        env: {
          ...process.env,
          HOME: tmpHome,
          GSTACK_PROFILE_SOURCE_DIR: src,
        },
      });
      // init must succeed (falls back to start dir when no .git/.gstack marker
      // below $HOME, so proj itself becomes the root)
      expect(r.status).toBe(0);
      // Profile created at the project level — not leaked to tmpHome/.gstack
      expect(fs.existsSync(path.join(proj, ".gstack", "profile.yaml"))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(tmpHome, ".gstack", "profile.yaml"))).toBe(
        false,
      );
      // No skills materialized into tmpHome/.claude/skills
      expect(fs.existsSync(path.join(tmpHome, ".claude", "skills"))).toBe(
        false,
      );
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
