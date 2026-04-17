/**
 * Tests for injectPriceLabels — Story 44.2 live pricing indicator.
 */

import { describe, it, expect } from "vitest";
import { injectPriceLabels } from "./wizard-helpers.js";
import type { ResourceField } from "../index.js";

/** Helper to build a minimal categorySelect field for testing. */
function makeCategoryField(
  fieldName: string,
  categories: Array<{
    key: string;
    label: string;
    options: Array<{ value: string; label: string }>;
  }>,
): ResourceField {
  return {
    name: fieldName,
    question: {
      type: "categorySelect" as const,
      label: "Pick one",
      categories: categories.map((c) => ({
        ...c,
        description: "",
      })),
    },
  };
}

/** Helper to build a minimal enum field for testing. */
function makeEnumField(
  fieldName: string,
  options: Array<{ value: string; label: string }>,
): ResourceField {
  return {
    name: fieldName,
    question: {
      type: "enum" as const,
      label: "Pick one",
      options,
    },
  };
}

describe("injectPriceLabels (Story 44.2)", () => {
  describe("(live) indicator on enriched options", () => {
    it("adds (live) suffix to options with live prices", () => {
      const field = makeEnumField("InstanceType", [
        { value: "t3.micro", label: "t3.micro (2 vCPU, 1 GiB) — ~$0.0104/hr" },
        { value: "t3.small", label: "t3.small (2 vCPU, 2 GiB) — ~$0.0208/hr" },
      ]);

      const result = injectPriceLabels([field], "InstanceType", {
        "t3.micro": "$0.0104/hr",
        "t3.small": "$0.0209/hr",
      });

      const opts = result[0]!.question.options!;
      expect(opts[0]!.label).toBe(
        "t3.micro (2 vCPU, 1 GiB) — $0.0104/hr (live)",
      );
      expect(opts[1]!.label).toBe(
        "t3.small (2 vCPU, 2 GiB) — $0.0209/hr (live)",
      );
    });

    it("retains original label for options NOT in priceMap", () => {
      const field = makeEnumField("InstanceType", [
        { value: "t3.micro", label: "t3.micro (2 vCPU, 1 GiB) — ~$0.0104/hr" },
        {
          value: "t3.small",
          label: "t3.small (2 vCPU, 2 GiB) — ~$0.0208/hr",
        },
      ]);

      const result = injectPriceLabels([field], "InstanceType", {
        "t3.micro": "$0.0104/hr",
        // t3.small NOT in map
      });

      const opts = result[0]!.question.options!;
      expect(opts[0]!.label).toContain("(live)");
      expect(opts[1]!.label).toBe("t3.small (2 vCPU, 2 GiB) — ~$0.0208/hr");
      expect(opts[1]!.label).not.toContain("(live)");
    });

    it("handles options without existing price separator", () => {
      const field = makeEnumField("SomeField", [
        { value: "opt1", label: "Option 1" },
      ]);

      const result = injectPriceLabels([field], "SomeField", {
        opt1: "$5.00/hr",
      });

      expect(result[0]!.question.options![0]!.label).toBe(
        "Option 1 — $5.00/hr (live)",
      );
    });
  });

  describe("categorySelect enrichment", () => {
    it("enriches option labels in categorySelect with (live)", () => {
      const field = makeCategoryField("InstanceType", [
        {
          key: "burstable",
          label: "Burstable (t3/t4g) — ~$0.008-0.17/hr",
          options: [
            {
              value: "t3.micro",
              label: "t3.micro (2 vCPU, 1 GiB) — ~$0.0104/hr",
            },
            {
              value: "t3.small",
              label: "t3.small (2 vCPU, 2 GiB) — ~$0.0208/hr",
            },
          ],
        },
      ]);

      const result = injectPriceLabels([field], "InstanceType", {
        "t3.micro": "$0.0104/hr",
        "t3.small": "$0.0208/hr",
      });

      const cat = result[0]!.question.categories![0]!;
      expect(cat.options[0]!.label).toBe(
        "t3.micro (2 vCPU, 1 GiB) — $0.0104/hr (live)",
      );
      expect(cat.options[1]!.label).toBe(
        "t3.small (2 vCPU, 2 GiB) — $0.0208/hr (live)",
      );
    });

    it("updates category header label with live price range", () => {
      const field = makeCategoryField("InstanceType", [
        {
          key: "burstable",
          label: "Burstable (t3/t4g) — ~$0.008-0.17/hr",
          options: [
            { value: "t3.micro", label: "t3.micro — ~$0.0104/hr" },
            { value: "t3.large", label: "t3.large — ~$0.0832/hr" },
          ],
        },
      ]);

      const result = injectPriceLabels([field], "InstanceType", {
        "t3.micro": "$0.0104/hr",
        "t3.large": "$0.0832/hr",
      });

      const cat = result[0]!.question.categories![0]!;
      expect(cat.label).toBe("Burstable (t3/t4g) — $0.0104-0.0832/hr (live)");
    });

    it("preserves category header when no options have live prices", () => {
      const field = makeCategoryField("InstanceType", [
        {
          key: "burstable",
          label: "Burstable (t3/t4g) — ~$0.008-0.17/hr",
          options: [{ value: "t3.micro", label: "t3.micro — ~$0.0104/hr" }],
        },
      ]);

      // Empty priceMap
      const result = injectPriceLabels([field], "InstanceType", {});
      const cat = result[0]!.question.categories![0]!;
      expect(cat.label).toBe("Burstable (t3/t4g) — ~$0.008-0.17/hr");
    });

    it("handles single-price category (min === max)", () => {
      const field = makeCategoryField("InstanceType", [
        {
          key: "gpu",
          label: "GPU — ~$4.10/hr",
          options: [{ value: "p3.2xlarge", label: "p3.2xlarge — ~$4.10/hr" }],
        },
      ]);

      const result = injectPriceLabels([field], "InstanceType", {
        "p3.2xlarge": "$3.06/hr",
      });

      const cat = result[0]!.question.categories![0]!;
      expect(cat.label).toBe("GPU — $3.06/hr (live)");
    });
  });

  describe("field filtering", () => {
    it("only enriches the targeted field, leaves others untouched", () => {
      const fields: ResourceField[] = [
        makeEnumField("InstanceType", [
          { value: "t3.micro", label: "t3.micro — ~$0.01/hr" },
        ]),
        makeEnumField("OtherField", [{ value: "val1", label: "Value 1" }]),
      ];

      const result = injectPriceLabels(fields, "InstanceType", {
        "t3.micro": "$0.0104/hr",
      });

      expect(result[0]!.question.options![0]!.label).toContain("(live)");
      expect(result[1]!.question.options![0]!.label).toBe("Value 1");
    });

    it("returns fields unchanged when priceMap is empty", () => {
      const field = makeEnumField("InstanceType", [
        { value: "t3.micro", label: "t3.micro — ~$0.0104/hr" },
      ]);

      const result = injectPriceLabels([field], "InstanceType", {});
      expect(result[0]!.question.options![0]!.label).toBe(
        "t3.micro — ~$0.0104/hr",
      );
    });
  });
});
