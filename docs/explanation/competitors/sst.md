# SST (Serverless Stack) / Ion

> _Snapshot date: April 2026. The competitive landscape moves fast — claims about specific pricing, feature surfaces, or roadmap items are accurate as of the date noted and may have shifted since. Verify against the linked official sources before acting on them._

## Positioning

SST is an open-source TypeScript framework for building full-stack apps on AWS. Components are high-level (`new sst.aws.Nextjs`, `new sst.aws.Function`, `new sst.aws.Bucket`) that compile down to multi-resource AWS stacks. The current engine is **Ion** (replaces the earlier CDK/CloudFormation-based SST v2); Ion is built on Pulumi/Terraform providers and removes CloudFormation dependency. Target user: TypeScript/Next.js developers who want AWS without writing IaC. License: MIT.

## Scope

- **Application framework first, infrastructure second.** SST optimizes the Next.js / Remix / SvelteKit / React Router deploy path on AWS. Non-web resources (raw EC2, RDS, VPCs, IAM roles) are possible but not the happy path.
- `sst deploy` / `sst dev` is the core workflow. Live Lambda dev (local code → cloud invoke) is the signature feature.
- **No natural-language provisioning surface.** The `demo-ai-app` repo and new Vector component add AI-related _runtime_ features (embeddings, semantic search) inside user apps — they don't let you describe infrastructure in English.
- SST Console provides dashboards, logs, and issue tracking for deployed apps.

## Where they win

- Best-in-class TypeScript DX for full-stack app deployment on AWS.
- Live-lambda-dev loop; framework-aware defaults eliminate CDK/Pulumi boilerplate.
- Strong community; MIT license; no state service lock-in (uses local or S3-backed Pulumi state).
- Covers the "Next.js + Lambda + S3 + CloudFront" archetype end-to-end.

## Where Assignee.ai differentiates

- **Input modality**: SST requires the user to write TypeScript code (`new sst.aws.Nextjs("MyWeb")`). Assignee takes plain English (`"deploy a static site with CDN"`) and runs an elicitation wizard.
- **Audience**: SST is for app developers already comfortable with TypeScript. Assignee targets operators, solo devs, and ops-adjacent engineers who don't want to author any code.
- **Safety loop**: Assignee ships with 185 BP rules, pre-apply cost estimation, and HITL. SST has none of these natively — cost surprises and insecure defaults are user-owned.
- **Resource breadth**: Assignee covers 37 raw AWS types (IAM, VPC, RDS, EFS, SQS, SNS, KMS, CloudWatch, etc.). SST's sweet spot is the web-app stack.
- **No state service**: Assignee uses CCAPI as source of truth. SST/Ion still manages Pulumi state artifacts.

## Source URLs

- https://sst.dev/
- https://github.com/sst/demo-ai-app
- https://sst.dev/docs/components/ (component reference)

## Related

- `competitors/pulumi-ai.md` — SST Ion runs on Pulumi's provider model
- `competitors/kagent.md` — different scope (K8s ops)
