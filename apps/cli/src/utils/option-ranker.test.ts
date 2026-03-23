import { describe, it, expect } from "vitest";
import { rankOptions } from "./option-ranker.js";
import type { WorkloadProfile } from "./option-ranker.js";

/** Helper: generates a set of EC2-like instance type options. */
function ec2Options() {
  return [
    { value: "t3.micro", label: "t3.micro (2 vCPU, 1 GiB)" },
    { value: "t3.small", label: "t3.small (2 vCPU, 2 GiB)" },
    { value: "t4g.micro", label: "t4g.micro (2 vCPU, 1 GiB) — ARM burst" },
    { value: "m5.large", label: "m5.large (2 vCPU, 8 GiB) — general purpose" },
    { value: "m6i.xlarge", label: "m6i.xlarge (4 vCPU, 16 GiB)" },
    {
      value: "c5.xlarge",
      label: "c5.xlarge (4 vCPU, 8 GiB) — compute optimized",
    },
    { value: "c6i.2xlarge", label: "c6i.2xlarge (8 vCPU, 16 GiB)" },
    {
      value: "r5.large",
      label: "r5.large (2 vCPU, 16 GiB) — memory optimized",
    },
    { value: "r6g.xlarge", label: "r6g.xlarge (4 vCPU, 32 GiB)" },
    {
      value: "p5.48xlarge",
      label: "p5.48xlarge (192 vCPU, 2048 GiB) — GPU ML",
    },
    { value: "g6.xlarge", label: "g6.xlarge (4 vCPU, 16 GiB) — GPU inference" },
    {
      value: "i3.large",
      label: "i3.large (2 vCPU, 15.25 GiB) — storage optimized",
    },
    { value: "d3.xlarge", label: "d3.xlarge (4 vCPU, 32 GiB) — dense storage" },
  ];
}

describe("rankOptions", () => {
  it("GPU profile ranks p5/g6 instances first", () => {
    const result = rankOptions(ec2Options(), "gpu-accelerated");

    // p5 and g6 should be in visible (they match gpu-accelerated keywords)
    const visibleValues = result.visible.map((o) => o.value);
    expect(visibleValues).toContain("p5.48xlarge");
    expect(visibleValues).toContain("g6.xlarge");

    // They should appear before non-GPU instances
    const p5Idx = visibleValues.indexOf("p5.48xlarge");
    const g6Idx = visibleValues.indexOf("g6.xlarge");
    // Both should be near the top
    expect(p5Idx).toBeLessThan(4);
    expect(g6Idx).toBeLessThan(4);

    expect(result.filtered).toBe(true);
    expect(result.profile).toBe("gpu-accelerated");
  });

  it("burstable profile ranks t3/t4g instances first", () => {
    const result = rankOptions(ec2Options(), "burstable");

    const visibleValues = result.visible.map((o) => o.value);
    // t3 and t4g options should be in visible and ranked high
    expect(visibleValues).toContain("t3.micro");
    expect(visibleValues).toContain("t3.small");
    expect(visibleValues).toContain("t4g.micro");

    // t3.micro matches both "t3" and "micro" — should rank high
    const t3MicroIdx = visibleValues.indexOf("t3.micro");
    expect(t3MicroIdx).toBeLessThan(3);

    expect(result.filtered).toBe(true);
  });

  it("unknown profile returns all options unfiltered", () => {
    const options = ec2Options();
    const result = rankOptions(options, "unknown");

    expect(result.filtered).toBe(false);
    expect(result.visible).toHaveLength(options.length);
    expect(result.overflow).toHaveLength(0);

    // Order should be preserved (not re-sorted)
    expect(result.visible[0]!.value).toBe(options[0]!.value);
    expect(result.visible[result.visible.length - 1]!.value).toBe(
      options[options.length - 1]!.value,
    );
  });

  it("maxVisible=5 returns only 5 in visible, rest in overflow", () => {
    const options = ec2Options();
    const result = rankOptions(options, "burstable", 5);

    expect(result.visible).toHaveLength(5);
    expect(result.overflow).toHaveLength(options.length - 5);
    // Total should equal original count
    expect(result.visible.length + result.overflow.length).toBe(options.length);
  });

  it("fewer options than maxVisible puts all in visible, empty overflow", () => {
    const fewOptions = [
      { value: "t3.micro", label: "t3.micro" },
      { value: "t3.small", label: "t3.small" },
    ];
    const result = rankOptions(fewOptions, "burstable", 8);

    expect(result.visible).toHaveLength(2);
    expect(result.overflow).toHaveLength(0);
  });

  it("recommended options get a score boost", () => {
    const options = [
      { value: "x1.large", label: "x1.large — unrelated", recommended: false },
      { value: "x2.large", label: "x2.large — unrelated", recommended: true },
      { value: "z1.large", label: "z1.large — unrelated", recommended: false },
    ];

    // With "unknown" profile, no ranking applied — skip this case
    // Use a profile where none of the options match keywords, so recommended is the differentiator
    const result = rankOptions(options, "storage-heavy", 2);

    // x2.large is not recommended but does not match storage keywords either...
    // Actually x2.large does NOT contain storage keywords. recommended=true gives it +10 bonus.
    // So x2.large should rank first.
    expect(result.visible[0]!.value).toBe("x2.large");
    expect(result.filtered).toBe(true);
  });

  it("sorts alphabetically by value when scores are tied", () => {
    const options = [
      { value: "z-instance", label: "Z Instance" },
      { value: "a-instance", label: "A Instance" },
      { value: "m-instance", label: "M Instance" },
    ];

    const result = rankOptions(options, "burstable");

    // None match burstable keywords, all score 0 → alphabetical sort
    const values = result.visible.map((o) => o.value);
    expect(values).toEqual(["a-instance", "m-instance", "z-instance"]);
  });

  it("compute-heavy profile ranks c5/c6i instances first", () => {
    const result = rankOptions(ec2Options(), "compute-heavy");

    const visibleValues = result.visible.map((o) => o.value);
    // c5 and c6i should be ranked high
    expect(visibleValues.indexOf("c5.xlarge")).toBeLessThan(3);
    expect(visibleValues.indexOf("c6i.2xlarge")).toBeLessThan(3);
  });

  it("memory-intensive profile ranks r5/r6g instances first", () => {
    const result = rankOptions(ec2Options(), "memory-intensive");

    const visibleValues = result.visible.map((o) => o.value);
    expect(visibleValues).toContain("r5.large");
    expect(visibleValues).toContain("r6g.xlarge");
  });

  it("strips extra properties from output — only value and label", () => {
    const options = [
      {
        value: "t3.micro",
        label: "t3.micro",
        recommended: true,
        costHint: "$0.01/hr",
      },
    ];
    const result = rankOptions(options, "burstable");

    const opt = result.visible[0]!;
    expect(Object.keys(opt)).toEqual(["value", "label"]);
  });

  it("handles empty options array", () => {
    const result = rankOptions([], "burstable");

    expect(result.visible).toHaveLength(0);
    expect(result.overflow).toHaveLength(0);
    expect(result.filtered).toBe(true);
  });
});
