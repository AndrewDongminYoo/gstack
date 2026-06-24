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
