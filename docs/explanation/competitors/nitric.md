# Nitric

> _Snapshot date: April 2026. The competitive landscape moves fast — claims about specific pricing, feature surfaces, or roadmap items are accurate as of the date noted and may have shifted since. Verify against the linked official sources before acting on them._

## Positioning

Nitric is an open-source **infrastructure-from-code** framework (nitrictech/nitric, $3.1M seed). Developers write application code in TypeScript/Python/Go/JavaScript/Dart using Nitric's SDK primitives (`api`, `bucket`, `queue`, `schedule`, `topic`, `kv`), and Nitric **infers the infrastructure** and generates Pulumi or Terraform plans to deploy to AWS / GCP / Azure / Kubernetes. Latest release v1.27.6 (February 2026); project is actively maintained post-Wing shutdown. Plugin-based deployment: you can swap Pulumi for Terraform for a custom provider.

## Scope

- **Multi-cloud by design** — same code deploys to AWS Lambda + API Gateway + SQS + DynamoDB, or GCP Cloud Functions + Pub/Sub + Firestore, or Azure Functions + Service Bus.
- Infrastructure is _inferred_ from code reads — `bucket.allow("read")` generates the matching IAM. No explicit IaC authoring.
- Target user is an application developer who wants to ship a cloud app without learning each cloud's provisioning API.
- Does not do drift detection, cost preview, or policy enforcement natively.

## Where they win

- True portable application layer across clouds — the only surviving IfC contender after Wing died.
- Inference model is lighter than Wing's language-level abstraction; adopts existing languages.
- Plugin architecture means teams can keep Pulumi or Terraform as the "real" IaC if they need to.
- Apache-2.0, meaningful GitHub traction, active releases into 2026.

## Where Assignee.ai differentiates

- **Different category.** Nitric is app-framework + IfC for _building new cloud apps_. Assignee is a provisioning CLI for _any AWS resource_, not just the IfC primitives (`api`, `bucket`, `queue`). Nitric has no path to "create me a VPC with 3 public + 3 private subnets in 3 AZs"; Assignee does.
- **Zero code artifact.** Nitric still produces Pulumi/Terraform under the hood, and the app code itself is the IaC source of truth — users own both. Assignee produces **only the deployed resource**, tagged with run-id.
- **HITL + cost preview + BP gates.** Nitric's deploy is CLI-invoke → it just runs. No English plan review, no cost gate, no 185 BP rules. Assignee's confirm step is central.
- **Not a multi-cloud play.** Assignee is AWS-native (Bedrock + CCAPI + MCP). Nitric's multi-cloud story is a moat Assignee chooses not to chase in v1.

## Source URLs

- https://nitric.io/
- https://github.com/nitrictech/nitric
- https://nitric.io/docs/get-started/foundations/infrastructure
- https://github.com/nitrictech/nitric/releases

## Related

- `competitors/wing.md` — dead IfC peer, contrast lesson
- `competitors/sst.md` — different IfC flavor, app-centric
- `competitors/pulumi-ai.md` — Nitric sits on top of Pulumi optionally
