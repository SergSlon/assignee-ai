# adapters/

Concrete implementations ("adapters") of the hexagonal **ports** declared
in `packages/core/src/ports/`.

## Intent

This directory exists so port implementations can be co-located by domain
under a single roof, rather than scattered next to each port's
domain-specific module. Subdirectories are organized by domain
(e.g. `adapters/llm/`, `adapters/cloudcontrol/`, `adapters/checkpoint/`).

The split mirrors the canonical hexagonal pattern:

- `ports/` — pure interfaces (no AWS SDK, no fs, no network). Stable
  contracts that the core graph depends on.
- `adapters/` — concrete impls of those interfaces (AWS SDK calls, fs,
  HTTP, in-memory fixtures for tests). Pluggable at the composition
  root.

## Migration status (MASTER-010)

This directory was created during MASTER-010 (hexagonal architecture
consolidation: Round 4c). Initially it is a **placeholder** —
adapters currently still live alongside their port-paired modules:

| Adapter                          | Current location                           | Future canonical home                 |
| -------------------------------- | ------------------------------------------ | ------------------------------------- |
| `InMemoryCheckpointerAdapter`    | `checkpoint/in-memory-adapter.ts`          | `adapters/checkpoint/in-memory.ts`    |
| `FileDurableCheckpointerAdapter` | `checkpoint/file-durable-adapter.ts`       | `adapters/checkpoint/file-durable.ts` |
| `InMemoryOIDCAdapter`            | `identity/in-memory-oidc-adapter.ts`       | (see "Exception" below)               |
| `FileAdvisoryLockAdapter`        | `locks/file-advisory-lock.ts`              | `adapters/locks/file.ts`              |
| `InMemoryTelemetryAdapter`       | `telemetry/in-memory-telemetry-adapter.ts` | `adapters/telemetry/in-memory.ts`     |
| `OtelExporter`                   | `telemetry/otel-exporter.ts`               | `adapters/telemetry/otel.ts`          |

Adapters will migrate into `adapters/` in a future wave. **Do not move
them as part of MASTER-010 Round 4c**; that wave is scope-locked to
port relocation only (keeps blast radius low).

## Exception: domain-cohesive co-location

The `identity/` module is the canonical co-located template — port +
adapter live in the same module folder when the adapter is tightly
coupled to identity-domain types and there is no reuse outside identity.
That arrangement does NOT need to migrate to `adapters/identity/`;
it is a deliberate domain-cohesion choice and supersedes the default
"adapters live under `adapters/`" rule for that module.

When in doubt, follow the default and put adapters under `adapters/`;
only co-locate when domain-cohesion explicitly justifies it.
