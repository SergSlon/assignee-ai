# Assignee.ai -- Source Tree Analysis

> Annotated directory tree reverse-engineered from source code, April 2026.

```
assignee.ai/
|
|-- package.json              Monorepo root (private, pnpm + Turborepo)
|-- pnpm-workspace.yaml       Workspace config: apps/* + packages/*
|-- turbo.json                Turborepo pipeline (build, test, lint)
|-- README.md                 Project readme
|
|-- apps/
|   |-- cli/                  *** MAIN CLI APPLICATION ***
|   |   |-- package.json      "assignee" binary, Commander.js
|   |   |-- tsconfig.json     TS config extending shared base
|   |   |-- src/
|   |   |   |-- index.ts      Entry point: .env loading, Commander setup, 12 commands
|   |   |   |-- index.test.ts
|   |   |   |-- distribution.test.ts  Package distribution validation
|   |   |   |
|   |   |   |-- commands/     *** CLI COMMANDS (Commander.js) ***
|   |   |   |   |-- plan.ts         `assignee plan <intent>` -- plan-only mode
|   |   |   |   |-- apply.ts        `assignee apply <intent>` -- plan + provision
|   |   |   |   |-- destroy.ts      `assignee destroy` -- single/bulk resource destruction
|   |   |   |   |-- list.ts         `assignee list` -- list managed resources
|   |   |   |   |-- status.ts       `assignee status` -- infrastructure summary + BP coverage
|   |   |   |   |-- drift.ts        `assignee drift` -- configuration drift detection
|   |   |   |   |-- reconcile.ts    `assignee reconcile` -- drift reconciliation
|   |   |   |   |-- init.ts         `assignee init` -- config file creation
|   |   |   |   |-- setup.ts        `assignee setup` -- IAM 3-user bootstrap
|   |   |   |   |-- cache.ts        `assignee cache` -- schema cache management
|   |   |   |   |-- clean.ts        `assignee clean` -- cleanup stale data + resources
|   |   |   |   |-- completions.ts  Shell completion generation
|   |   |   |   |-- status-bp-coverage.ts  BP rule coverage dashboard
|   |   |   |
|   |   |   |-- nodes/        *** LANGGRAPH PIPELINE NODES ***
|   |   |   |   |-- intent-parser.ts        N1: NL -> resource type / pattern
|   |   |   |   |-- schema-fetcher.ts       N2: CloudFormation schema retrieval
|   |   |   |   |-- option-elicitor.ts      N3: Interactive wizard + pricing + config
|   |   |   |   |-- compound-dispatcher.ts  N4: Single vs. compound routing
|   |   |   |   |-- plan-generator.ts       N5: LLM -> desired state JSON
|   |   |   |   |-- bp-evaluator.ts         N6: Best practice rule evaluation
|   |   |   |   |-- fix-applicator.ts       N7: Auto-fix BP patches
|   |   |   |   |-- preflight-guard.ts      N8: Cost + validation + IAM gate
|   |   |   |   |-- human-approval.ts       N9: HITL confirmation
|   |   |   |   |-- resource-provisioner.ts N10: CloudControl/SDK provisioning
|   |   |   |   |-- status-poller.ts        N11: Async operation polling
|   |   |   |   |-- result-formatter.ts     N12: Final output + memory + security
|   |   |   |   |-- __tests__/             Node-specific test fixtures
|   |   |   |
|   |   |   |-- services/     *** BUSINESS LOGIC SERVICES ***
|   |   |   |   |-- graph.ts               LangGraph graph construction (wiring)
|   |   |   |   |-- graph-state.ts         State annotation definition
|   |   |   |   |-- graph-routing.ts       Conditional edge routing functions
|   |   |   |   |-- llm-adapter.ts         Universal LLM adapter (Vercel AI SDK)
|   |   |   |   |-- bedrock-llm-adapter.ts Direct Bedrock adapter
|   |   |   |   |-- mcp-client.ts          MCP server process manager (singleton)
|   |   |   |   |-- cloudcontrol-client.ts CloudControl SDK client factory
|   |   |   |   |-- cloudcontrol-adapter.ts ProvisioningPort implementation
|   |   |   |   |-- sdk-fallback-dispatcher.ts SDK for CCAPI gap types
|   |   |   |   |-- provisioning-port.ts   Abstract provisioning interface
|   |   |   |   |-- memory.ts              JSON-file provision/failure/pattern logs
|   |   |   |   |-- checkpoint.ts          Plan checkpoint save/load/prune
|   |   |   |   |-- cleanup.ts             Cleanup orchestrator
|   |   |   |   |-- price-cache.ts         TTL-based pricing cache
|   |   |   |   |-- list-resources.ts      Resource Groups Tagging API queries
|   |   |   |   |-- billing.ts             Live cost data from billing MCP
|   |   |   |   |-- drift-detector.ts      Deep-diff drift detection
|   |   |   |   |-- drift-detector-factory.ts Factory for drift detector
|   |   |   |   |-- destroy-service.ts     Single-resource destroy logic
|   |   |   |   |-- bulk-destroy.ts        Tier-ordered bulk destroy
|   |   |   |   |-- resource-resolver.ts   ARN/name resource resolution
|   |   |   |   |-- status-aggregator.ts   Status data aggregation
|   |   |   |   |-- credential-detector.ts AWS credential auto-detection
|   |   |   |   |-- completion-generator.ts Shell completion generation
|   |   |   |   |-- desired-state-sanitizer.ts Strip extraneous CFN keys
|   |   |   |   |-- required-field-repairer.ts Fill missing required fields
|   |   |   |   |-- s3-upload.ts           Static site upload to S3
|   |   |   |   |-- cloudfront-setup.ts    CloudFront distribution creation
|   |   |   |   |-- __tests__/            Service test fixtures
|   |   |   |
|   |   |   |-- utils/        *** UTILITIES AND HELPERS ***
|   |   |   |   |-- display.ts             Plan box, prompts, spinners, tables (clack)
|   |   |   |   |-- display-plan.ts        Plan rendering helpers
|   |   |   |   |-- display-output.ts      Output rendering helpers
|   |   |   |   |-- display-prompts.ts     Interactive prompt helpers
|   |   |   |   |-- display-findings.ts    BP findings display
|   |   |   |   |-- display-docs.ts        Documentation display helpers
|   |   |   |   |-- ui.ts                  UI constants and helpers
|   |   |   |   |-- logger.ts              Structured JSON logger (stderr)
|   |   |   |   |-- error-messages.ts      User-friendly error message registry
|   |   |   |   |-- merge-configs.ts       6-level config precedence resolver
|   |   |   |   |-- aws-resource-discovery.ts  AMI, VPC, subnet, SG discovery
|   |   |   |   |-- option-enrichment.ts   Option label enrichment
|   |   |   |   |-- option-ranker.ts       Option ranking/sorting
|   |   |   |   |-- pricing-lookup.ts      Price label injection
|   |   |   |   |-- free-tier.ts           Free tier eligibility detection
|   |   |   |   |-- tags.ts               Mandatory tag injection
|   |   |   |   |-- mcp.ts                MCP response unwrapping
|   |   |   |   |-- mcp-types.ts          MCP type utilities
|   |   |   |   |-- timeout.ts            Promise timeout wrapper
|   |   |   |   |-- recorder.ts           API call recording interceptor
|   |   |   |   |-- memory-recorder.ts    Memory write helpers
|   |   |   |   |-- security-posture.ts   Post-provision security checks
|   |   |   |   |-- field-resolver.ts     Dynamic field resolution
|   |   |   |   |-- resolve-desired-state.ts  Desired state resolution for drift
|   |   |   |   |-- fix-command-resolver.ts  Fix command resolution
|   |   |   |   |-- fix-selection.ts       Interactive fix selection
|   |   |   |   |-- bp-reeval.ts           BP re-evaluation after fixes
|   |   |   |   |-- intent-defaults.ts     Intent-based default values
|   |   |   |   |-- workload-classifier.ts Workload profile classification
|   |   |   |   |-- wizard-helpers.ts      Wizard utility functions
|   |   |   |   |-- wizard-key-map.ts      CFN key to wizard key mapping
|   |   |   |   |-- wizard-recommendations.ts  Contextual recommendations
|   |   |   |   |-- env-writer.ts          .env file writing
|   |   |   |   |-- first-run.ts           First-run detection and bootstrap
|   |   |   |   |-- command-runner.ts      Graph execution wrapper
|   |   |   |   |-- iam-actions.ts         IAM action resolution
|   |   |   |
|   |   |   |-- config/       *** CONFIGURATION ***
|   |   |   |   |-- constants.ts           All string constants and defaults
|   |   |   |   |-- mcp-servers.ts         MCP server process configs
|   |   |   |   |-- operator-credentials.ts AWS credential resolution
|   |   |   |   |-- user-config-loader.ts  User config (~/.config/assignee/)
|   |   |   |   |-- project-config-loader.ts Project config (.assignee/)
|   |   |   |   |-- org-policy-loader.ts   Remote org policy
|   |   |   |   |-- org-policy-cache.ts    Org policy caching
|   |   |   |   |-- env-overrides.ts       ASSIGNEE_* env var overrides
|   |   |   |
|   |   |   |-- constants/    *** ENUMS AND MAGIC-STRING CONSTANTS ***
|   |   |   |   |-- graph.ts              Graph node names
|   |   |   |   |-- commands.ts           Command names, descriptions, args
|   |   |   |   |-- errors.ts             Error codes, exit codes, providers
|   |   |   |   |-- env-vars.ts           Environment variable names
|   |   |   |   |-- cfn-keys.ts           CloudFormation property key constants
|   |   |   |   |-- tools.ts              MCP tool names
|   |   |   |   |-- mcp.ts               MCP server names
|   |   |   |   |-- pricing.ts            Pricing term constants
|   |   |   |   |-- aws-errors.ts         AWS error name constants
|   |   |   |   |-- field-policy.ts       Field policy + source enums
|   |   |   |   |-- instance-categories.ts EC2 instance category groupings
|   |   |   |   |-- workload-profiles.ts  Workload profile definitions
|   |   |   |   |-- resource-fields.ts    Resource field constants
|   |   |   |   |-- reconcile-actions.ts  Reconcile action types
|   |   |   |   |-- doc-sections.ts       Documentation section constants
|   |   |   |   |-- time-budget.ts        Performance time budget constants
|   |   |   |
|   |   |   |-- views/        *** VIEW RENDERERS ***
|   |   |   |   |-- drift-detail.ts       Drift detail rendering
|   |   |   |   |-- drift-report.ts       Drift report building
|   |   |   |   |-- drift-progress.ts     Drift progress bar
|   |   |   |
|   |   |   |-- telemetry/    *** TELEMETRY ***
|   |   |   |   |-- timing.ts            Performance timing
|   |   |   |
|   |   |   |-- mcp/          *** MCP CLIENT HELPERS ***
|   |   |   |
|   |   |   |-- e2e/          *** END-TO-END TEST INFRASTRUCTURE ***
|   |   |   |
|   |   |   |-- __tests__/    *** TEST FIXTURES AND SHARED HELPERS ***
|   |   |   |-- test-fixtures/ Test data files
|   |
|   |-- mcp-server/           *** MCP SERVER APPLICATION ***
|   |   |-- package.json      "@assignee/mcp-server" binary
|   |   |-- src/
|   |   |   |-- index.ts      Entry: McpServer setup, stdio transport
|   |   |   |-- tools/        5 MCP tool registrations
|   |   |   |   |-- index.ts              Tool barrel
|   |   |   |   |-- plan-resource.ts      plan_resource tool
|   |   |   |   |-- apply-plan.ts         apply_plan tool
|   |   |   |   |-- list-managed-resources.ts  list_managed_resources tool
|   |   |   |   |-- estimate-cost.ts      estimate_cost tool
|   |   |   |   |-- destroy-resource.ts   destroy_resource tool
|   |   |   |-- services/     Server-side services
|   |   |   |   |-- graph-init.ts         Graph context initialization
|   |   |   |   |-- checkpoint.ts         MCP checkpoint management
|   |   |   |   |-- cost-estimator.ts     Keyword-based resource classification
|   |   |   |   |-- list-resources.ts     Resource listing
|   |   |   |   |-- free-tier.ts          Free tier awareness
|   |   |   |   |-- destroy-strategies/   Type-specific destroy handlers
|   |   |   |-- __tests__/    MCP server tests
|
|-- packages/
|   |-- core/                 *** SHARED CORE PACKAGE ***
|   |   |-- src/
|   |   |   |-- index.ts      Barrel export for all core types
|   |   |   |-- errors.ts     Error class hierarchy
|   |   |   |-- errors/
|   |   |   |   |-- hint-registry.ts  User-friendly error hints
|   |   |   |-- schema/       Zod schemas
|   |   |   |   |-- graph-state.ts    ExecutionMode, ExecutionStatus enums
|   |   |   |   |-- audit.ts          Audit event schema
|   |   |   |   |-- checkpoint.ts     Plan checkpoint schema
|   |   |   |   |-- memory.ts         Provision/failure/pattern log schemas
|   |   |   |   |-- drift.ts          Drift detection types
|   |   |   |-- config/       Configuration constants
|   |   |   |   |-- cfn-keys.ts       CloudFormation key constants
|   |   |   |   |-- resource-types.ts Resource type constants (23 types)
|   |   |   |   |-- resource-identifiers.ts Primary identifier keys
|   |   |   |   |-- resource-policy.ts Org/user field policy types
|   |   |   |   |-- arn-type-map.ts   ARN-to-CloudFormation type mapping
|   |   |   |   |-- aws-arns.ts       AWS ARN prefix constants
|   |   |   |   |-- discovery-keys.ts Discovery cache keys
|   |   |   |   |-- iam-actions.ts    Required IAM actions per resource
|   |   |   |   |-- iam-policies.ts   IAM policy generators
|   |   |   |   |-- iam-effects.ts    IAM effect constants
|   |   |   |   |-- config-schema.ts  AssigneeConfig Zod schema
|   |   |   |   |-- index.ts          Config barrel
|   |   |   |-- resource-plugins/  Plugin registry + 24 plugins
|   |   |   |   |-- index.ts         Registry with all registrations
|   |   |   |   |-- registry.ts      PluginRegistry class
|   |   |   |   |-- types.ts         ResourcePlugin, ResourceField types
|   |   |   |   |-- field-labels.ts  Human-readable field labels
|   |   |   |   |-- shared-fields.ts Shared field definitions
|   |   |   |   |-- companion-resources.ts  Companion resource collection
|   |   |   |   |-- integrations/    Cross-resource integrations
|   |   |   |   |-- plugins/         24 plugin implementations
|   |   |   |-- pattern-templates/  Compound pattern registry
|   |   |   |   |-- index.ts         Registry with 7 patterns
|   |   |   |   |-- registry.ts      PatternRegistry class
|   |   |   |   |-- types.ts         ArchitecturePattern, ResourceSpec types
|   |   |   |   |-- pattern-ids.ts   Pattern ID constants
|   |   |   |   |-- pattern-resource-ids.ts  Resource ID constants
|   |   |   |   |-- patterns/        7 pattern implementations
|   |   |   |-- pricing/       Pricing engine
|   |   |   |   |-- index.ts         Registries with all strategies/decomposers
|   |   |   |   |-- registry.ts      PricingStrategyRegistry
|   |   |   |   |-- decomposer-registry.ts  PricingDecomposerRegistry
|   |   |   |   |-- mcp-parser.ts    MCP pricing response parser
|   |   |   |   |-- types.ts         Pricing types
|   |   |   |   |-- decomposer-types.ts  Decomposer types
|   |   |   |   |-- filter-constants.ts  Pricing filter constants
|   |   |   |   |-- strategies/      23 pricing strategies
|   |   |   |   |-- decomposers/     23 pricing decomposers
|   |   |   |-- ports/         Hexagonal architecture ports
|   |   |   |   |-- llm-port.ts      Abstract LLM interface
|   |   |   |   |-- mock-llm-adapter.ts  Mock for testing
|   |   |   |-- services/     Core services
|   |   |   |   |-- cloudformation-schema-service.ts  Schema fetch + disk cache
|   |   |   |   |-- schema-adapter.ts     DescribeType -> MCP format adapter
|   |   |   |   |-- schema-cache-warmer.ts  Pre-fetch all schemas
|   |   |   |-- types/        Core domain types
|   |   |   |   |-- result.ts   Result<T> tuple type
|   |   |   |   |-- plan.ts     Plan Zod schema
|   |   |   |-- utils/        Core utilities
|   |   |       |-- sanitize.ts  Intent sanitization (prompt injection)
|   |
|   |-- best-practices/       *** BEST PRACTICES ENGINE ***
|   |   |-- src/
|   |   |   |-- index.ts      Barrel export
|   |   |   |-- loader.ts     YAML file loader with Zod validation
|   |   |   |-- evaluate.ts   Trigger evaluation engine
|   |   |   |-- schema.ts     Best practice Zod schema
|   |   |   |-- types.ts      BestPractice, BPFinding types
|   |   |-- s3/               17 S3 best practice YAML rules
|   |   |-- ec2/              EC2 best practice YAML rules
|   |   |-- rds/              RDS best practice YAML rules
|   |   |-- lambda/           Lambda best practice YAML rules
|   |   |-- iam/              IAM best practice YAML rules
|   |   |-- dynamodb/         DynamoDB best practice YAML rules
|   |   |-- vpc/              VPC best practice YAML rules
|   |   |-- sqs/              SQS best practice YAML rules
|   |   |-- sns/              SNS best practice YAML rules
|   |   |-- ecs/              ECS best practice YAML rules
|   |   |-- ecr/              ECR best practice YAML rules
|   |   |-- elbv2/            ELBv2 best practice YAML rules
|   |   |-- logs/             CloudWatch Logs best practice YAML rules
|   |   |-- cloudwatch/       CloudWatch Alarm best practice YAML rules
|   |   |-- secretsmanager/   Secrets Manager best practice YAML rules
|   |   |-- ssm/              SSM Parameter best practice YAML rules
|   |   |-- apigateway/       API Gateway best practice YAML rules
|   |   |-- autoscaling/      Auto Scaling best practice YAML rules
|
|-- docs/                     *** PROJECT DOCUMENTATION ***
|-- scripts/                  Build/utility scripts
|-- homebrew/                 Homebrew formula for distribution
|-- _bmad-output/             BMAD planning artifacts
```
