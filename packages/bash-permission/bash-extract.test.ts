import { describe, expect, it } from "vitest";
import { extractCommands } from "./lib/bash-extract.js";

describe("bash-extract", () => {
  describe("simple commands", () => {
    it("extracts git status", () => {
      expect(extractCommands("git status")).toEqual({ commands: ["git status"], error: null });
    });

    it("extracts ls -la", () => {
      expect(extractCommands("ls -la")).toEqual({ commands: ["ls -la"], error: null });
    });

    it("extracts pwd", () => {
      expect(extractCommands("pwd")).toEqual({ commands: ["pwd"], error: null });
    });
  });

  describe("chained commands", () => {
    it("extracts && chain", () => {
      expect(extractCommands("git log && echo done")).toEqual({
        commands: ["git log", "echo done"],
        error: null,
      });
    });

    it("extracts || chain", () => {
      expect(extractCommands("cd dir || mkdir dir")).toEqual({
        commands: ["cd dir", "mkdir dir"],
        error: null,
      });
    });

    it("extracts semicolon chain", () => {
      expect(extractCommands("cd dir; echo done")).toEqual({
        commands: ["cd dir", "echo done"],
        error: null,
      });
    });
  });

  describe("pipeline commands", () => {
    it("extracts simple pipe", () => {
      expect(extractCommands("git log | grep fix")).toEqual({
        commands: ["git log", "grep fix"],
        error: null,
      });
    });

    it("extracts triple pipe", () => {
      expect(extractCommands("cat file | grep foo | head -5")).toEqual({
        commands: ["cat file", "grep foo", "head -5"],
        error: null,
      });
    });
  });

  describe("subshell commands", () => {
    it("extracts subshell with chain", () => {
      expect(extractCommands("(cd dir && make)")).toEqual({
        commands: ["cd dir", "make"],
        error: null,
      });
    });

    it("extracts subshell in chain", () => {
      expect(extractCommands("(cd a || cd b) && echo done")).toEqual({
        commands: ["cd a", "cd b", "echo done"],
        error: null,
      });
    });
  });

  describe("command substitution", () => {
    it("extracts command substitution in string", () => {
      const result = extractCommands('echo "$(git log)"');
      expect(result.commands).toContain('echo "$(git log)"');
      expect(result.commands).toContain("git log");
      expect(result.error).toBeNull();
    });
  });

  describe("redirected statements", () => {
    it("extracts > redirect", () => {
      expect(extractCommands("echo hello > file")).toEqual({
        commands: ["echo hello > file"],
        error: null,
      });
    });

    it("extracts pipe with redirect", () => {
      expect(extractCommands("git log | grep foo > output.txt")).toEqual({
        commands: ["git log", "grep foo > output.txt"],
        error: null,
      });
    });
  });

  describe("error handling", () => {
    it("returns error for standalone &&", () => {
      const result = extractCommands("&&");
      expect(result.error).not.toBeNull();
      expect(result.commands).toEqual([]);
    });

    it("returns error for unclosed substitution", () => {
      const result = extractCommands('echo "$(pwd');
      expect(result.error).not.toBeNull();
      expect(result.commands).toEqual([]);
    });

    it("returns no error for empty input", () => {
      const result = extractCommands("");
      expect(result.error).toBeNull();
      expect(result.commands).toEqual([]);
    });

    it("returns no error for whitespace input", () => {
      const result = extractCommands("   ");
      expect(result.error).toBeNull();
      expect(result.commands).toEqual([]);
    });
  });
});
