# CDK AI (Amazon Q Developer + CDK + Generative-AI CDK Constructs)

> _Snapshot date: April 2026. The competitive landscape moves fast — claims about specific pricing, feature surfaces, or roadmap items are accurate as of the date noted and may have shifted since. Verify against the linked official sources before acting on them._

## Positioning

"CDK AI" is the AWS-native AI layer on top of the AWS Cloud Development Kit (AWS CDK). It has three components:

1. **Amazon Q Developer** (AWS, ubiquitous) — AI coding assistant in IDE + CLI. Generates CDK (TypeScript/Python/Java/C#/Go), CloudFormation, or Terraform from NL. Console-to-Code feature records AWS Console clicks and emits equivalent CDK/CFN/Terraform. Free with AWS accounts + paid Pro tier.
2. **Generative-AI CDK Constructs** (awslabs, Apache-2.0) — opinionated L3 constructs for Bedrock Agents, Knowledge Bases, RAG pipelines, vector stores. Not an AI-writes-CDK tool — AI-infrastructure building blocks _for_ CDK users.
3. **CDK-for-Terraform (CDKTF)** — **deprecated December 2025**; Terraform-target CDK dialect dead.

The net product: "Describe infra in English in your IDE → Amazon Q emits CDK → you run `cdk deploy` → CloudFormation provisions."

## Scope

- **AWS-only** by architectural constraint — CDK synthesizes to CloudFormation.
- Uses **CloudFormation as the provisioning engine** (with all its limits: 500 resources/stack, slow changesets, cryptic bootstrap errors, resource-type lag on new services).
- Amazon Q Console-to-Code is free with AWS accounts; Amazon Q Developer Pro is $19/user/mo.
- Generative-AI CDK Constructs is OSS, no pricing.

## Where they win

- **Free** + AWS-native + deeply integrated into the AWS Console / CloudShell / every IDE.
- **Official AWS support** — never going away, always current on AWS service launches.
- **Console-to-Code** is a genuinely unique ClickOps-to-IaC path.
- **CDK's L2/L3 construct library** — mature patterns for VPCs, ECS, pipelines.
- **Distribution moat** — every AWS developer already has an AWS account.

## Where Assignee.ai differentiates

- **No CloudFormation layer.** Assignee provisions via CCAPI; CFN's stack limits, drift, and 45-min rollbacks don't apply. CDK AI deploys are rate-limited by CFN throughput.
- **No CDK to maintain.** CDK AI emits TypeScript/Python code the user must version, review, and re-run. Assignee produces only the deployed resource.
- **HITL in English, not CDK diff review.** Amazon Q emits code; the user still reads `CfnBucket` parameters to trust it.
- **Cost preflight + 185 BP rules.** Amazon Q emits code that _might_ be best-practice; Assignee mutates the plan pre-apply with a validated rule set and blocks confirm on cost.
- **Amazon Q is AWS-only-forever by policy.** Assignee's architecture (LangGraph + MCP + Bedrock) is AWS-native today but not AWS-bound — multi-cloud is technically reachable (Epic 13 deferred).
- **Honest risk:** Amazon Q is free and distributed to every AWS account — Assignee's value must clear the "why not just use Q?" bar for every AWS-only user. The answer today is cost-preflight + HITL + BP auto-fix + no-CFN-stack-overhead, but Q can close these gaps.

## Source URLs

- https://aws.amazon.com/q/developer/
- https://aws.amazon.com/q/developer/features/
- https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/console-to-code.html
- https://awslabs.github.io/generative-ai-cdk-constructs/
- https://aws.amazon.com/blogs/devops/how-to-use-amazon-q-developer-to-deploy-a-serverless-web-application-with-aws-cdk/

## Related

- `competitors/pulumi-ai.md` — multi-cloud analog with Neo agent
- `competitors/terraform-ai.md` — HashiCorp's answer
- `competitors/claude-writes-terraform.md` — the generic-LLM baseline
