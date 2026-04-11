/**
 * Instance type catalog — the authoritative list of EC2 instance types the
 * CLI offers in the wizard and uses for workload-profile classification.
 *
 * Story 46.4 (2026-04-12): this registry used to live inline in
 * `plugins/ec2-instance.ts`, which meant a CLI release was required every
 * time AWS added a new instance family. Extracting it to a dedicated module
 * gives us a single source of truth and a clean seam for a future
 * `.assignee/config.yaml`-driven override (Phase 2 — the merge logic that
 * unions config-defined categories on top of these defaults is deferred
 * until the first user actually asks for custom types; adding it here
 * without a user would be speculative).
 *
 * Each category maps a family key to its display metadata and member
 * instance types. Approximate us-east-1 on-demand prices as of 2026-04,
 * updated via `scripts/update-wizard-prices.ts`.
 *
 * @see Story 18.12 — original category shape
 * @see plugins/ec2-instance.ts — sole consumer (wizard CATEGORY_SELECT)
 */

import { SizeLabel, WorkloadProfileKey } from "../config/cfn-keys.js";

export const INSTANCE_CATEGORIES = [
  {
    key: WorkloadProfileKey.BURSTABLE,
    label: "Burstable (t3/t4g) — ~$0.008-0.17/hr",
    description:
      "Variable CPU with burst credits. Best for dev/test and intermittent workloads. t4g (ARM) is ~20% cheaper.",
    options: [
      {
        value: "t3.micro",
        label: "t3.micro  (2 vCPU,  1 GiB) — ~$0.0104/hr",
        fitHint: "Dev/test, free tier eligible",
      },
      {
        value: "t3.small",
        label: "t3.small  (2 vCPU,  2 GiB) — ~$0.0208/hr",
        fitHint: "Light workloads",
        recommended: true,
      },
      {
        value: "t3.medium",
        label: "t3.medium (2 vCPU,  4 GiB) — ~$0.0416/hr",
        fitHint: SizeLabel.SMALL_PRODUCTION,
      },
      {
        value: "t3.large",
        label: "t3.large  (2 vCPU,  8 GiB) — ~$0.0832/hr",
        fitHint: SizeLabel.MEDIUM_PRODUCTION,
      },
      {
        value: "t3.xlarge",
        label: "t3.xlarge (4 vCPU, 16 GiB) — ~$0.1664/hr",
        fitHint: "Large burstable",
      },
      {
        value: "t4g.micro",
        label: "t4g.micro  (2 vCPU,  1 GiB) — ~$0.0084/hr",
        fitHint: "Dev/test, Graviton ARM",
      },
      {
        value: "t4g.small",
        label: "t4g.small  (2 vCPU,  2 GiB) — ~$0.0168/hr",
        fitHint: "Light workloads, 20% cheaper than t3",
      },
      {
        value: "t4g.medium",
        label: "t4g.medium (2 vCPU,  4 GiB) — ~$0.0336/hr",
        fitHint: "ARM-compatible production",
      },
      {
        value: "t4g.large",
        label: "t4g.large  (2 vCPU,  8 GiB) — ~$0.0672/hr",
        fitHint: "Medium ARM production",
      },
      {
        value: "t4g.xlarge",
        label: "t4g.xlarge (4 vCPU, 16 GiB) — ~$0.1344/hr",
        fitHint: "Large ARM burstable",
      },
    ],
  },
  {
    key: WorkloadProfileKey.GENERAL,
    label: "General Purpose (m5/m6i) — ~$0.096-0.38/hr",
    description:
      "Balanced CPU/memory ratio. Best for production app servers and mid-size databases.",
    options: [
      {
        value: "m5.large",
        label: "m5.large   (2 vCPU,  8 GiB) — ~$0.0960/hr",
        fitHint: "General-purpose production",
      },
      {
        value: "m5.xlarge",
        label: "m5.xlarge  (4 vCPU, 16 GiB) — ~$0.1920/hr",
        fitHint: "Compute-intensive",
      },
      {
        value: "m5.2xlarge",
        label: "m5.2xlarge (8 vCPU, 32 GiB) — ~$0.3840/hr",
        fitHint: "High-performance",
      },
      {
        value: "m6i.large",
        label: "m6i.large   (2 vCPU,  8 GiB) — ~$0.0960/hr",
        fitHint: "Latest gen general-purpose",
      },
      {
        value: "m6i.xlarge",
        label: "m6i.xlarge  (4 vCPU, 16 GiB) — ~$0.1920/hr",
        fitHint: "Latest gen, higher throughput",
      },
      {
        value: "m6i.2xlarge",
        label: "m6i.2xlarge (8 vCPU, 32 GiB) — ~$0.3840/hr",
        fitHint: "Latest gen high-performance",
      },
    ],
  },
  {
    key: WorkloadProfileKey.COMPUTE,
    label: "Compute Optimized (c5/c6i) — ~$0.085-0.34/hr",
    description:
      "High-performance CPUs. Best for batch processing, ML inference, and compute-heavy workloads.",
    options: [
      {
        value: "c5.large",
        label: "c5.large   (2 vCPU,  4 GiB) — ~$0.0850/hr",
        fitHint: "Compute-heavy, batch processing",
      },
      {
        value: "c5.xlarge",
        label: "c5.xlarge  (4 vCPU,  8 GiB) — ~$0.1700/hr",
        fitHint: "High-performance compute",
      },
      {
        value: "c5.2xlarge",
        label: "c5.2xlarge (8 vCPU, 16 GiB) — ~$0.3400/hr",
        fitHint: "Compute-intensive workloads",
      },
      {
        value: "c6i.large",
        label: "c6i.large   (2 vCPU,  4 GiB) — ~$0.0850/hr",
        fitHint: SizeLabel.LATEST_GEN_COMPUTE,
      },
      {
        value: "c6i.xlarge",
        label: "c6i.xlarge  (4 vCPU,  8 GiB) — ~$0.1700/hr",
        fitHint: SizeLabel.LATEST_GEN_COMPUTE,
      },
      {
        value: "c6i.2xlarge",
        label: "c6i.2xlarge (8 vCPU, 16 GiB) — ~$0.3400/hr",
        fitHint: "Latest gen compute-heavy",
      },
    ],
  },
  {
    key: WorkloadProfileKey.MEMORY,
    label: "Memory Optimized (r5/r6i) — ~$0.126-0.50/hr",
    description:
      "High memory-to-CPU ratio. Best for in-memory databases, caches, and real-time analytics.",
    options: [
      {
        value: "r5.large",
        label: "r5.large   (2 vCPU, 16 GiB) — ~$0.1260/hr",
        fitHint: "Memory-intensive, caches",
      },
      {
        value: "r5.xlarge",
        label: "r5.xlarge  (4 vCPU, 32 GiB) — ~$0.2520/hr",
        fitHint: "In-memory databases",
      },
      {
        value: "r5.2xlarge",
        label: "r5.2xlarge (8 vCPU, 64 GiB) — ~$0.5040/hr",
        fitHint: "Large in-memory workloads",
      },
      {
        value: "r6i.large",
        label: "r6i.large   (2 vCPU, 16 GiB) — ~$0.1260/hr",
        fitHint: "Latest gen memory-optimized",
      },
      {
        value: "r6i.xlarge",
        label: "r6i.xlarge  (4 vCPU, 32 GiB) — ~$0.2520/hr",
        fitHint: "Latest gen in-memory",
      },
      {
        value: "r6i.2xlarge",
        label: "r6i.2xlarge (8 vCPU, 64 GiB) — ~$0.5040/hr",
        fitHint: "Latest gen memory-heavy",
      },
    ],
  },
] as const;
