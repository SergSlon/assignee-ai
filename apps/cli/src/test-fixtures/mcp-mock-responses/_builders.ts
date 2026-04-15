// AUTO-GENERATED — split from monolith mcp-mock-responses.ts (story 48-10).
import { mcpText } from "./_helpers.js";

export function buildPricingResponse(priceUsd: number) {
  return mcpText({
    data: [
      {
        terms: {
          OnDemand: {
            "TERM-1": {
              priceDimensions: {
                "DIM-1": {
                  beginRange: "0",
                  pricePerUnit: { USD: String(priceUsd) },
                },
              },
            },
          },
        },
      },
    ],
  });
}

export function buildMultiTierPricingResponse(
  tiers: Array<[string, string, number]>,
) {
  const priceDimensions: Record<string, unknown> = {};
  tiers.forEach(([beginRange, endRange, priceUsd], i) => {
    priceDimensions[`DIM-${i}`] = {
      beginRange,
      endRange,
      pricePerUnit: { USD: String(priceUsd) },
    };
  });

  return mcpText({
    data: [
      {
        terms: {
          OnDemand: {
            "TERM-MULTI": { priceDimensions },
          },
        },
      },
    ],
  });
}

export function buildSchemaResponse(
  typeName: string,
  properties: Record<string, unknown>,
  required: string[] = [],
) {
  return mcpText({
    typeName,
    properties,
    required,
  });
}

export function buildDocSearchResponse(urls: string[]) {
  return {
    structuredContent: {
      search_results: urls.map((url) => ({ url })),
    },
  };
}

export function buildDocReadResponse(content: string) {
  return mcpText(content);
}
