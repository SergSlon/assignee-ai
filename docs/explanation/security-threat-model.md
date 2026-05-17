# Assignee.ai Security Threat Model (STUB)

**Status**: stub — to be completed before v1.0 publish (RR-5).
**Story**: 108-A-06 (stub creation); full content is a separate backlog story
(see `_backlog/rr-5-threat-model-content.md`).

## Sections to cover

1. **Trust boundaries** — CLI ↔ AWS API ↔ LLM ↔ MCP server.
2. **Credentials handling** — IAM role chain, MCP credential resolution lazy-per-server.
3. **Telemetry boundary** — opt-in event emission, no silent collection.
4. **Plan/apply isolation** — preflight guards, ARN partition awareness.
5. **Destruct safety** — bulk-destroy IAM allowlist, placeholder ARN rejection.
6. **Supply chain** — npm provenance (RR-8), 3rd-party attribution (RR-7).

Full content is tracked as a separate story (see `_backlog/rr-5-threat-model-content.md`).

## Compliance baseline

Assignee.ai is a developer tool, not a regulated-environment runtime. The threat
model is sized for that scope.
