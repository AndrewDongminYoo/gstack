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

  test("both global-linking blocks are gated (two opt-in branches)", () => {
    const count =
      SETUP_SRC.split("gstack ready (per-project / opt-in).").length - 1;
    expect(count).toBe(2);
  });
});

describe("setup: F1 — cleanup_self_prefixed_claude_symlinks for opt-in mode", () => {
  test("defines cleanup_self_prefixed_claude_symlinks helper", () => {
    expect(SETUP_SRC).toContain("cleanup_self_prefixed_claude_symlinks() {");
  });

  test("calls cleanup_self_prefixed_claude_symlinks exactly twice (once per per-project branch)", () => {
    // The definition line has no args; only the two call sites have args.
    const callCount =
      SETUP_SRC.split(
        'cleanup_self_prefixed_claude_symlinks "$SOURCE_GSTACK_DIR" "$INSTALL_SKILLS_DIR"',
      ).length - 1;
    expect(callCount).toBe(2);
  });
});

describe("setup: F2 — gstack-profile PATH-launcher is Windows-guarded", () => {
  test("the gstack-profile launcher snippet is guarded by IS_WINDOWS check", () => {
    // The snippet that links gstack-profile into ~/.local/bin must be inside
    // a condition that checks IS_WINDOWS, so Windows users get the full-path tip
    // instead of a mis-resolving copy.
    const idx = SETUP_SRC.indexOf('[ "$IS_WINDOWS" -eq 0 ]');
    const profileIdx = SETUP_SRC.indexOf("gstack-profile", idx);
    expect(idx).toBeGreaterThan(0);
    // gstack-profile must appear after the IS_WINDOWS guard
    expect(profileIdx).toBeGreaterThan(idx);
  });
});
