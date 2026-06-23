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
