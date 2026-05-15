# Intent Parser — Classification Architecture

The intent parser is the first node in the Assignee.ai LangGraph pipeline. It converts a free-text user request ("create a serverless API with a Lambda and DynamoDB table") into a structured routing decision: either a single `resourceType` (e.g. `AWS::S3::Bucket`) or a compound `resourcePattern` (a multi-resource blueprint).

## Two-tier classification

### Tier 1 — keyword registry (zero latency, deterministic)

The keyword classifier runs first, **always**. It is a case-insensitive substring scan against the `PatternRegistry` catalogue. If any registered pattern's keywords match the intent, the compound pattern is selected immediately — no LLM call is made.

This tier is the primary cost guardrail:

- Keyword hits are free (zero Bedrock calls).
- New compound patterns need a keyword list; adding keywords is the cheap path for known, stable phrasings.

### Tier 2 — LLM compound fallback (Epic-107 Story 1)

When Tier 1 returns null AND the intent is ≥ 10 words (the "cheap gate"), the parser invokes a structured Bedrock call:

> "Given the catalogue of N known compound patterns, which pattern (or NONE) best matches this intent?"

The LLM response is Zod-validated:

```typescript
{
  patternKey: string | null,  // null → no catalogue match
  confidence: "high" | "medium" | "low",
  rationale: string           // for logging only
}
```

Acceptance rules:

- `confidence === "low"` → treated as null (falls through to Tier 3).
- `patternKey` not in the live registry → treated as null (hallucination guard).
- Schema-rejection or Bedrock error → falls through to Tier 3 without crashing.

Cost: each Tier 2 call is a Sonnet-class request (~500-token prompt + ~150-token response, approximately 650 tokens total). Callsite: `intent-parser/compound-classifier-llm`. Token spend is greppable via the structured-log stream.

**Cost-ceiling note**: Tier 2 is currently not cached. If production telemetry shows Tier 2 firing frequently for common intents, an LRU cache keyed by intent-hash is the recommended follow-up (filed as a deferred backlog item).

### Tier 3 — Bedrock resource-type classifier

When both keyword and compound-LLM classifiers return null (or the intent is < 10 words), the standard Bedrock classification runs. It classifies the intent into a single CFN resource type or `UNSUPPORTED`. An `UNSUPPORTED` result triggers the SX-1 advisory message ("I couldn't identify the resource type; try…").

## Classification decision tree

```
sanitize intent
    ↓
singleton-override? → YES → extract + route as single resource
    ↓ NO
literal pattern-ID lookup → HIT → extract + route as compound
    ↓ MISS
keyword-registry.detect() → HIT → extract + route as compound
    ↓ MISS
intent < 10 words? → YES → skip compound-LLM, go to Tier 3
    ↓ NO
LLM compound-classifier → high/medium match + in registry? → extract + route as compound
    ↓ null / low / schema-error
Bedrock resource-type classifier (kind + resourceType)
    ↓
query → query_handler node
destroy → redirect message
UNSUPPORTED → SX-1 advisory
create/update → schema_fetcher → plan_generator → …
```

## Adding a new compound pattern

1. Create the pattern file in `packages/core/src/pattern-templates/patterns/`.
2. Register it in `packages/core/src/pattern-templates/index.ts`.
3. Add keywords that cover the most common user phrasings (Tier 1 handles them for free).
4. The LLM fallback (Tier 2) automatically covers unusual phrasings — no keyword PR loop needed.

## Testing intent-parser changes

- Unit tests: `src/graph/nodes/intent-parser/**/*.test.ts`
- Integration tests: `src/graph/nodes/intent-parser/__tests__/llm-fallback-integration.test.ts`
- Existing orchestrator tests: `src/graph/nodes/intent-parser.test.ts`

All tests mock `LlmPort` via constructor injection — no real Bedrock calls in CI.
