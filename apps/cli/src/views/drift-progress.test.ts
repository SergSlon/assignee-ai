import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import { renderProgressBar, formatProgressBar } from "./drift-progress.js";

describe("drift-progress", () => {
  describe("formatProgressBar", () => {
    it("returns empty string for zero total", () => {
      expect(formatProgressBar(0, 0, 0)).toBe("");
    });

    it("shows 0% at start", () => {
      const bar = formatProgressBar(0, 10, 0);
      expect(bar).toContain("0/10");
      expect(bar).toContain("0 drifted");
      expect(bar).toContain("Checking resources...");
    });

    it("shows 50% at halfway", () => {
      const bar = formatProgressBar(5, 10, 1);
      expect(bar).toContain("5/10");
      expect(bar).toContain("1 drifted");
    });

    it("shows 100% when complete", () => {
      const bar = formatProgressBar(10, 10, 2);
      expect(bar).toContain("10/10");
      expect(bar).toContain("2 drifted");
    });

    it("includes block characters in the bar", () => {
      const bar = formatProgressBar(5, 10, 0);
      expect(bar).toContain("\u2588"); // filled
      expect(bar).toContain("\u2591"); // empty
    });
  });

  describe("renderProgressBar", () => {
    let stderrSpy: MockInstance;

    beforeEach(() => {
      stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
    });

    afterEach(() => {
      stderrSpy.mockRestore();
    });

    it("writes to stderr", () => {
      renderProgressBar(3, 10, 1);
      expect(stderrSpy).toHaveBeenCalled();
      const output = stderrSpy.mock.calls.map((c) => c[0]).join("");
      expect(output).toContain("3/10");
    });

    it("does not write for zero total", () => {
      renderProgressBar(0, 0, 0);
      expect(stderrSpy).not.toHaveBeenCalled();
    });
  });
});
