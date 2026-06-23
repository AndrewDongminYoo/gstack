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
