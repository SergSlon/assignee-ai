# Competitor analyses

> _Snapshot date: April 2026. These one-pagers compare Assignee.ai to adjacent tools that solve overlapping problems. The competitive landscape moves fast — verify against the linked official sources before acting on any specific claim._

These are honest reads on tools an operator might pick instead of (or alongside) Assignee.ai. The README's [§2 differentiator table](../../../README.md#2-solution) is the one-screen summary; the docs below go deeper per tool.

| Tool                                                      | Category                                                  | Snapshot                                             |
| :-------------------------------------------------------- | :-------------------------------------------------------- | :--------------------------------------------------- |
| [CDK + Amazon Q](cdk-ai.md)                               | AWS-native, AWS CDK + AI assistant + GenAI CDK Constructs | AI writes CDK; you still own bootstrap + state       |
| [Claude / Cursor + Terraform](claude-writes-terraform.md) | The raw-LLM baseline                                      | The honest "do I even need Assignee?" bar            |
| [kagent](kagent.md)                                       | Kubernetes day-2 ops with AI agents                       | Diagnoses + reconciles inside K8s; not a provisioner |
| [Nitric](nitric.md)                                       | Infrastructure-from-code, multi-cloud                     | Code defines infra; Pulumi/Terraform under the hood  |
| [Pulumi AI / Copilot / Neo](pulumi-ai.md)                 | Multi-cloud IaC with agentic AI                           | Pulumi code + state + paid Cloud platform            |
| [SST Ion](sst.md)                                         | TypeScript serverless framework                           | Optimised for Next.js / Remix / Svelte on AWS        |
| [Terraform AI](terraform-ai.md)                           | HCP Terraform / Spacelift Intent / ControlMonkey          | NL → HCL with policy gates; HCL + state remain       |
| [Wing / Winglang](wing.md)                                | Obituary                                                  | Shut down April 2025; included for completeness      |

## How to read these

Each one-pager opens with **Positioning** (what it is, who it's for), then **Scope** (where it overlaps with Assignee.ai), and closes with the honest answer: when to pick this tool instead. The differentiator table in the README is intentionally narrow — these notes give the why behind each row.
