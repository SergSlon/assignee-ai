import { z } from "zod";
import {
  ExecutionStatus,
  RESOURCE_TYPES,
  SUPPORTED_TYPES_ARRAY as SUPPORTED_TYPES,
  defaultPatternRegistry,
  renderSupportedTypesHint,
  sanitizeUserIntent,
} from "../../index.js";
import type { LlmPort } from "../../index.js";
import { log, LOG_ACTIONS } from "../../utils/logger/index.js";
import type { AgentState } from "../graph-state.js";

/**
 * Human-readable hint shown when an unsupported resource type is
 * requested. Pulled from the core help-hints single source of truth
 * (Story 54-it1-04) so the node's errorMessage, the CLI's `--help`
 * output, and the MCP plan-resource tool all render from the same
 * registry-derived strings. The `short` style omits the EFS/CFN
 * detail lines to keep the inline graph-state errorMessage compact.
 */
const SUPPORTED_TYPES_HINT = renderSupportedTypesHint("short");

const intentParserSchema = z.object({
  resourceType: z.enum([...SUPPORTED_TYPES, "UNSUPPORTED"] as [
    string,
    ...string[],
  ]),
});

// ---------------------------------------------------------------------------
// Epic 92 wave 2 — user-asserted token extraction.
// ---------------------------------------------------------------------------
//
// The defaults engine (intent-defaults/) historically rewrote user-asserted
// values: e.g. "t3.micro web server" was rewritten to t3.small, "10.42.0.0/16"
// silently overridden to 10.0.0.0/16. The parser now pre-extracts tokens
// from the user's natural-language intent and writes them to
// `elicitedOptions` before the defaults engine runs. Defaults only fill
// absent keys; they never override an assertion.
//
// Invalid asserted values fail the plan with an actionable error — no
// silent fallback. This closes findings B-01, B-07, B-09, B-16, C-12,
// C-13, A-03.

/** Known EC2 instance-type family prefixes (current-gen + common legacy). */
const INSTANCE_FAMILY_PREFIXES: ReadonlySet<string> = new Set([
  // Burstable
  "t2",
  "t3",
  "t3a",
  "t4g",
  // General purpose
  "m4",
  "m5",
  "m5a",
  "m5n",
  "m6i",
  "m6a",
  "m6g",
  "m7i",
  "m7g",
  // Compute optimised
  "c4",
  "c5",
  "c5a",
  "c5n",
  "c6i",
  "c6a",
  "c6g",
  "c7i",
  "c7g",
  // Memory optimised
  "r4",
  "r5",
  "r5a",
  "r5b",
  "r5n",
  "r6i",
  "r6a",
  "r6g",
  "r7i",
  "r7g",
  "x1",
  "x1e",
  "x2iezn",
  "x2iedn",
  "x2idn",
  "z1d",
  // Storage optimised
  "i3",
  "i3en",
  "i4i",
  "d2",
  "d3",
  "d3en",
  "h1",
  // Accelerated
  "p3",
  "p4d",
  "p4de",
  "p5",
  "g3",
  "g4dn",
  "g5",
  "g5g",
  "inf1",
  "inf2",
  "trn1",
  // Legacy
  "a1",
]);

/** Known EC2 instance-size suffixes. */
const INSTANCE_SIZE_SUFFIXES: ReadonlySet<string> = new Set([
  "nano",
  "micro",
  "small",
  "medium",
  "large",
  "xlarge",
  "2xlarge",
  "3xlarge",
  "4xlarge",
  "6xlarge",
  "8xlarge",
  "9xlarge",
  "10xlarge",
  "12xlarge",
  "16xlarge",
  "18xlarge",
  "24xlarge",
  "32xlarge",
  "48xlarge",
  "metal",
]);

/**
 * Standard AWS commercial + GovCloud regions. Kept local to the parser
 * so validation doesn't depend on runtime MCP calls — the parser runs
 * before any MCP resolution and should fail fast on hallucinated
 * region strings.
 */
const KNOWN_AWS_REGIONS: ReadonlySet<string> = new Set([
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "us-gov-east-1",
  "us-gov-west-1",
  "af-south-1",
  "ap-east-1",
  "ap-south-1",
  "ap-south-2",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-southeast-4",
  "ca-central-1",
  "ca-west-1",
  "cn-north-1",
  "cn-northwest-1",
  "eu-central-1",
  "eu-central-2",
  "eu-north-1",
  "eu-south-1",
  "eu-south-2",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "il-central-1",
  "me-central-1",
  "me-south-1",
  "sa-east-1",
]);

/** Validates VPC-grade CIDR (/16-/28) per RFC 4632 + AWS VPC limits. */
export function isValidCidr(value: string, kind: "vpc" | "source"): boolean {
  const cidrRegex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
  const match = cidrRegex.exec(value);
  if (!match) return false;
  const octets = [match[1], match[2], match[3], match[4]].map(Number);
  if (octets.some((o) => o < 0 || o > 255)) return false;
  const prefix = Number(match[5]);
  if (kind === "vpc") return prefix >= 16 && prefix <= 28;
  return prefix >= 0 && prefix <= 32;
}

/**
 * Validates an EC2 instance-type token against a known-family set.
 * Returns true only when both the family prefix (e.g. `t3`) and the
 * size suffix (e.g. `micro`) are recognised. Rejects hallucinated
 * values like `t99.huge` — finding C-13.
 */
export function isValidInstanceType(value: string): boolean {
  const lower = value.toLowerCase();
  const dot = lower.indexOf(".");
  if (dot < 1) return false;
  const family = lower.slice(0, dot);
  const size = lower.slice(dot + 1);
  return (
    INSTANCE_FAMILY_PREFIXES.has(family) && INSTANCE_SIZE_SUFFIXES.has(size)
  );
}

/** Matches the AWS AMI identifier format (`ami-` + 8 or 17 lowercase hex). */
export function isValidAmiId(value: string): boolean {
  return /^ami-([0-9a-f]{8}|[0-9a-f]{17})$/.test(value);
}

/** Matches an RDS-compatible engine version tuple like `16.3` or `8.0.35`. */
export function isValidEngineVersion(value: string): boolean {
  if (!/^\d+(\.\d+){1,2}$/.test(value)) return false;
  const parts = value.split(".").map(Number);
  // Reject 99.99 / 999.* adversarial inputs — AWS RDS engine majors are all
  // below 20 for commercial engines (Postgres 17, MySQL 8.x, MariaDB 11.x,
  // Oracle 21, SQL Server 16, Aurora 3.x). Minor/patch can go higher but
  // an all-nines tuple is a clear hallucination signal.
  if (parts[0] !== undefined && parts[0] >= 50) return false;
  return true;
}

/** User-intent signals engine-version is being discussed. */
function mentionsDatabaseEngine(intentLower: string): boolean {
  return /\b(postgres(ql)?|mysql|mariadb|aurora|oracle|sql server|sqlserver|rds|db\s*engine)\b/.test(
    intentLower,
  );
}

export interface AssertionExtraction {
  elicited: Record<string, unknown>;
  errors: string[];
}

/**
 * Pre-extract user-asserted values from the natural-language intent.
 *
 * The extractor is intentionally conservative: a token is recognised only
 * when it is unambiguous (CIDR shape, AMI shape, known instance family
 * prefix + suffix, known region). Tokens that LOOK like an assertion but
 * fail validation produce a user-visible error — we never silently fall
 * back to defaults on an adversarial input.
 *
 * @param intent  Sanitised user intent string.
 * @param resourceType  Resolved resource type (may be empty for pattern match).
 */
export function extractAssertedValues(
  intent: string,
  resourceType: string,
): AssertionExtraction {
  const elicited: Record<string, unknown> = {};
  const errors: string[] = [];
  const intentLower = intent.toLowerCase();

  extractCidr(intent, resourceType, elicited, errors);
  extractInstanceType(intent, elicited, errors);
  extractAmiId(intent, elicited, errors);
  extractRegion(intent, elicited, errors);
  extractEngineVersion(intent, intentLower, elicited, errors);
  extractResourceName(intent, resourceType, elicited);
  extractSgIngress(intent, elicited, errors);
  extractNoVpcDirective(intentLower, elicited);
  extractSnsProtocol(intent, intentLower, resourceType, elicited);

  return { elicited, errors };
}

/** Extracts the first CIDR-shaped token; fails on invalid. */
function extractCidr(
  intent: string,
  resourceType: string,
  elicited: Record<string, unknown>,
  errors: string[],
): void {
  const cidrRegex = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}\b/g;
  const matches = intent.match(cidrRegex);
  if (!matches || matches.length === 0) return;

  // First CIDR token → CidrBlock (VPC / Subnet / Route context)
  // Additional CIDRs become SecurityGroupIngress sources downstream.
  const primary = matches[0]!;
  // Choose validation kind based on resource context. VPC / Subnet / Route
  // demand /16-/28; SG sources can be /0-/32.
  const isNetworkResource =
    resourceType === RESOURCE_TYPES.EC2_VPC ||
    resourceType === RESOURCE_TYPES.EC2_SUBNET ||
    resourceType === RESOURCE_TYPES.EC2_ROUTE;
  const kind = isNetworkResource ? "vpc" : "source";
  if (!isValidCidr(primary, kind)) {
    errors.push(
      `Invalid CIDR block "${primary}". Expected IPv4 CIDR (e.g. 10.0.0.0/16). Each octet must be 0-255 and the prefix must be 16-28 for a VPC.`,
    );
    return;
  }
  // Network resources → CidrBlock; other resources → informational hint.
  if (isNetworkResource) {
    elicited["CidrBlock"] = primary;
  } else {
    elicited["__assertedCidr"] = primary;
  }
  // Validate all CIDR tokens so adversarial inputs anywhere fail loudly.
  for (let i = 1; i < matches.length; i++) {
    if (!isValidCidr(matches[i]!, "source")) {
      errors.push(
        `Invalid CIDR block "${matches[i]}". Expected IPv4 CIDR (e.g. 10.0.0.0/16).`,
      );
    }
  }
}

/** Extracts an EC2 instance-type token; fails on unknown family/size. */
function extractInstanceType(
  intent: string,
  elicited: Record<string, unknown>,
  errors: string[],
): void {
  // Match `<family>.<size>` word-bounded — e.g. t3.micro, m5.large, p4d.24xlarge.
  // Allow alphanumeric family tokens but keep the match tight so we don't
  // pick up unrelated dotted strings (hostnames, file names, etc.).
  const typeRegex = /\b([a-z][0-9][a-z]*[0-9]*[a-z]?)\.([a-z0-9]+)\b/gi;
  let match: RegExpExecArray | null;
  let found: string | null = null;
  while ((match = typeRegex.exec(intent)) !== null) {
    const token = match[0].toLowerCase();
    // Skip tokens that don't look like <family>.<size> at all (hostnames etc.)
    const family = match[1]!.toLowerCase();
    if (!INSTANCE_FAMILY_PREFIXES.has(family)) continue;
    if (!isValidInstanceType(token)) {
      errors.push(
        `Unknown EC2 instance type "${match[0]}". Use a valid family (t3, m5, c5, r5, ...) and size (micro, small, medium, large, xlarge, ...).`,
      );
      return;
    }
    found = token;
    break;
  }

  // Second pass: catch shapes that LOOK like an instance type but whose
  // family is unrecognised (adversarial "t99.huge"). Only fail if the
  // token is in an EC2/instance context — otherwise hostnames with dots
  // would trigger a false positive.
  if (!found) {
    const ctxRegex =
      /\b(?:ec2|instance|instance\s+type|compute)\b[^\n.]{0,120}?\b([a-z][0-9][a-z]*[0-9]*[a-z]?)\.([a-z0-9]+)\b/i;
    const ctxMatch = ctxRegex.exec(intent);
    if (ctxMatch) {
      const candidate = `${ctxMatch[1]!.toLowerCase()}.${ctxMatch[2]!.toLowerCase()}`;
      if (!isValidInstanceType(candidate)) {
        errors.push(
          `Unknown EC2 instance type "${candidate}". Use a valid family (t3, m5, c5, r5, ...) and size (micro, small, medium, large, xlarge, ...).`,
        );
        return;
      }
    }
  }

  if (found) elicited["InstanceType"] = found;
}

/** Extracts an AMI id; fails on malformed hex. */
function extractAmiId(
  intent: string,
  elicited: Record<string, unknown>,
  errors: string[],
): void {
  const amiRegex = /\bami-[0-9a-zA-Z]{1,17}\b/g;
  const match = intent.match(amiRegex);
  if (!match || match.length === 0) return;
  const token = match[0]!;
  if (!isValidAmiId(token)) {
    errors.push(
      `Invalid AMI ID "${token}". Expected ami- followed by 8 or 17 hex characters (0-9a-f).`,
    );
    return;
  }
  elicited["ImageId"] = token;
}

/** Extracts an AWS region token; fails on unknown region. */
function extractRegion(
  intent: string,
  elicited: Record<string, unknown>,
  errors: string[],
): void {
  // Match region-shaped tokens with 2-4 hyphen-separated segments, the
  // last segment being a number. Examples we want to catch:
  //   us-east-1, eu-west-2, us-gov-east-1, eu-west-fake-1
  // The last form is adversarial (C-13) — we need to match it so
  // validation can fail loudly rather than silently accepting.
  const regionRegex = /\b([a-z]{2,3}(?:-[a-z]+){1,3}-\d+)\b/g;
  const matches = intent.match(regionRegex);
  if (!matches || matches.length === 0) return;
  // Pick the first candidate whose leading segment is 2-3 lowercase
  // letters (the AWS convention) so we don't false-positive on
  // ami- / arn- / other prefixed tokens.
  const candidate = matches.find((t) => /^[a-z]{2,3}-/.test(t));
  if (!candidate) return;
  if (!KNOWN_AWS_REGIONS.has(candidate)) {
    errors.push(
      `Unknown AWS region "${candidate}". Use a valid region code (e.g. us-east-1, eu-west-1, ap-southeast-2).`,
    );
    return;
  }
  elicited["__assertedRegion"] = candidate;
}

/** Extracts an RDS engine-version token when the intent signals RDS. */
function extractEngineVersion(
  intent: string,
  intentLower: string,
  elicited: Record<string, unknown>,
  errors: string[],
): void {
  if (!mentionsDatabaseEngine(intentLower)) return;
  // semver-like token, allowing 1-2 dots (16.3 or 8.0.35).
  const verRegex = /\b(\d+\.\d+(?:\.\d+)?)\b/g;
  let match: RegExpExecArray | null;
  while ((match = verRegex.exec(intent)) !== null) {
    const token = match[1]!;
    // Skip tokens that look like a CIDR fragment (already handled) or a
    // duration ("8.0" in "8.0 seconds") — require the engine-version
    // token to sit within ~40 chars of an engine keyword.
    const lo = Math.max(0, match.index - 40);
    const window = intentLower.slice(lo, match.index + token.length + 40);
    if (
      !/\b(postgres(ql)?|mysql|mariadb|aurora|oracle|sql server|sqlserver|version|engine)\b/.test(
        window,
      )
    ) {
      continue;
    }
    if (!isValidEngineVersion(token)) {
      errors.push(
        `Invalid RDS engine version "${token}". Use a supported version for your engine (e.g. Postgres 16.3, MySQL 8.0.35).`,
      );
      return;
    }
    elicited["EngineVersion"] = token;
    return;
  }
}

/** Extracts "named X" / "called X" resource identifier. */
function extractResourceName(
  intent: string,
  resourceType: string,
  elicited: Record<string, unknown>,
): void {
  // AWS resource names are typically [a-zA-Z0-9_-] with length limits that
  // vary by service. Accept a conservative identifier pattern here; the
  // plugin-level validators will flag service-specific limits later.
  const nameRegex = /\b(?:named|called)\s+['"]?([A-Za-z][A-Za-z0-9_-]{0,63})\b/;
  const match = nameRegex.exec(intent);
  if (!match) return;
  const name = match[1]!;
  const nameField = resolveNameField(resourceType);
  if (nameField) elicited[nameField] = name;
}

function resolveNameField(resourceType: string): string | null {
  switch (resourceType) {
    case RESOURCE_TYPES.LAMBDA_FUNCTION:
      return "FunctionName";
    case RESOURCE_TYPES.DYNAMODB_TABLE:
      return "TableName";
    case RESOURCE_TYPES.SNS_TOPIC:
      return "TopicName";
    case RESOURCE_TYPES.SQS_QUEUE:
      return "QueueName";
    case RESOURCE_TYPES.S3_BUCKET:
      return "BucketName";
    case RESOURCE_TYPES.ECS_CLUSTER:
      return "ClusterName";
    case RESOURCE_TYPES.ECR_REPOSITORY:
      return "RepositoryName";
    case RESOURCE_TYPES.LOGS_LOG_GROUP:
      return "LogGroupName";
    case RESOURCE_TYPES.IAM_ROLE:
      return "RoleName";
    default:
      return null;
  }
}

/** Extracts SG ingress port+CIDR+protocol triples. */
function extractSgIngress(
  intent: string,
  elicited: Record<string, unknown>,
  errors: string[],
): void {
  // Phrases we match:
  //   "allowing port 443"
  //   "allow port 22 from 0.0.0.0/0"
  //   "port 8080 tcp"
  //   "port 80-443"  (range)
  //   "open port 443"
  // We assemble one SecurityGroupIngress entry per port phrase found.
  const phraseRegex =
    /\b(?:allow(?:ing)?|open(?:ing)?|port[s]?)\s+(?:tcp\s+|udp\s+)?(?:port\s+)?(\d{1,5})(?:-(\d{1,5}))?(?:\s+(?:from\s+)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}))?(?:\s+(tcp|udp|icmp))?/gi;
  const ingress: Array<Record<string, unknown>> = [];
  let match: RegExpExecArray | null;
  while ((match = phraseRegex.exec(intent)) !== null) {
    const fromPort = Number(match[1]);
    const toPort = match[2] !== undefined ? Number(match[2]) : fromPort;
    if (fromPort < 0 || fromPort > 65535 || toPort < 0 || toPort > 65535) {
      errors.push(
        `Invalid port "${match[1]}${match[2] !== undefined ? `-${match[2]}` : ""}". Ports must be 0-65535.`,
      );
      continue;
    }
    const cidr = match[3];
    if (cidr !== undefined && !isValidCidr(cidr, "source")) {
      errors.push(
        `Invalid CIDR block "${cidr}" in security-group ingress rule.`,
      );
      continue;
    }
    const protocol = (match[4] ?? "tcp").toLowerCase();
    ingress.push({
      IpProtocol: protocol,
      FromPort: fromPort,
      ToPort: toPort,
      CidrIp: cidr ?? "0.0.0.0/0",
    });
  }
  if (ingress.length > 0) {
    elicited["SecurityGroupIngress"] = ingress;
  }
}

/** Extracts explicit "no VPC" / "standalone" directive. */
function extractNoVpcDirective(
  intentLower: string,
  elicited: Record<string, unknown>,
): void {
  const noVpc =
    /\b(?:do not attach (?:to )?(?:any )?vpc|without (?:a|any) vpc|no vpc|standalone sg|standalone security group|not attached to any vpc)\b/.test(
      intentLower,
    );
  if (noVpc) elicited["__noVpc"] = true;
}

/** Extracts SNS::Subscription Protocol from Endpoint token. */
function extractSnsProtocol(
  intent: string,
  intentLower: string,
  resourceType: string,
  elicited: Record<string, unknown>,
): void {
  if (resourceType !== RESOURCE_TYPES.SNS_SUBSCRIPTION) return;
  // URL scheme → protocol (most common, closes D-26 half).
  const httpsMatch = /\bhttps:\/\/\S+/i.exec(intent);
  const httpMatch = /\bhttp:\/\/\S+/i.exec(intent);
  const sqsArnMatch = /arn:aws[\w-]*:sqs:[^\s"']+/i.exec(intent);
  const lambdaArnMatch = /arn:aws[\w-]*:lambda:[^\s"']+/i.exec(intent);
  const emailMatch = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i.exec(intent);
  if (httpsMatch) {
    elicited["Protocol"] = "https";
    elicited["Endpoint"] = httpsMatch[0];
    return;
  }
  if (httpMatch) {
    elicited["Protocol"] = "http";
    elicited["Endpoint"] = httpMatch[0];
    return;
  }
  if (sqsArnMatch) {
    elicited["Protocol"] = "sqs";
    elicited["Endpoint"] = sqsArnMatch[0];
    return;
  }
  if (lambdaArnMatch) {
    elicited["Protocol"] = "lambda";
    elicited["Endpoint"] = lambdaArnMatch[0];
    return;
  }
  if (emailMatch && /\b(email|notify|subscribe)\b/.test(intentLower)) {
    elicited["Protocol"] = "email";
    elicited["Endpoint"] = emailMatch[0];
  }
}

/**
 * Factory for the intent_parser LangGraph node.
 * Accepts llmClient via injection — no direct @ai-sdk imports.
 *
 * @see Story 9.5 — LLM client decoupling (M3)
 */
export function createIntentParserNode({ llmClient }: { llmClient: LlmPort }) {
  return async function intentParserNode(
    state: AgentState,
  ): Promise<Partial<AgentState>> {
    // Sanitize user intent first (NFR-16: Prompt Injection Protection)
    const safeIntent = sanitizeUserIntent(state.userIntent);

    // Pattern detection — zero latency, no LLM call when pattern matches
    const detectedPattern = defaultPatternRegistry.detect(safeIntent);
    if (detectedPattern !== null) {
      // Pre-extract asserted tokens so compound-plan consumers (downstream
      // wave) can honour user-specified CIDR / region / names even when
      // the pattern matcher short-circuits the LLM classifier.
      const extraction = extractAssertedValues(safeIntent, "");
      if (extraction.errors.length > 0) {
        return {
          userIntent: safeIntent,
          executionStatus: ExecutionStatus.FAILED,
          errorMessage: `Intent validation failed: ${extraction.errors.join(" ")}`,
        };
      }
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.INTENT_PARSED,
        extras: { resourceType: null, pattern: detectedPattern.patternId },
      });
      const merged = mergeElicited(state.elicitedOptions, extraction.elicited);
      const mergedPresets = mergePresetFields(
        state.presetFields,
        extraction.elicited,
      );
      return {
        userIntent: safeIntent,
        resourcePattern: detectedPattern,
        ...(merged !== undefined ? { elicitedOptions: merged } : {}),
        ...(mergedPresets !== undefined ? { presetFields: mergedPresets } : {}),
      };
    }

    // Bedrock classification — uses sanitized intent.
    // Wave-4 F5 P2-R2-6: three disambiguation sentences were added so that
    // "Create a standalone X" / "Create an X on its own" always classifies
    // as the bare X type instead of being rerouted through a compound
    // pattern. Needed to unblock three previously-skipped E2E plan tests
    // for bare RDS DBInstance / Events Connection / Events ApiDestination
    // — each is first-class in SUPPORTED_TYPES but the LLM defaulted to
    // compound-style routing without explicit guidance.
    const prompt = `Classify this AWS infrastructure request into one of these types: ${SUPPORTED_TYPES.join(", ")} or UNSUPPORTED.
If the request says "standalone", "bare", "single", "on its own", or "just the X" (or otherwise explicitly asks for one resource in isolation), classify it as that exact type — do NOT reroute to a compound / multi-resource pattern even if the resource is usually deployed alongside others.
Events::Connection and Events::ApiDestination ARE first-class types in this list — classify as those when the intent is to create the Connection or ApiDestination itself, even without an accompanying Rule or EventBus.
RDS::DBInstance is first-class and MUST be classified as AWS::RDS::DBInstance when the request asks for a standalone database, regardless of whether a VPC / subnet group is mentioned.

Request: "${safeIntent}"`;
    const [err, output] = await llmClient.generateStructured(
      prompt,
      intentParserSchema,
      { callsite: "intent_parser", runId: state.runId },
    );

    if (err) {
      return {
        userIntent: safeIntent,
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: `Intent parsing failed. Hint: check Bedrock connectivity and AWS credentials. Error: ${err.message}`,
      };
    }

    if (output.resourceType === "UNSUPPORTED") {
      return {
        userIntent: safeIntent,
        executionStatus: ExecutionStatus.UNSUPPORTED_RESOURCE,
        errorMessage: `Unsupported resource type. ${SUPPORTED_TYPES_HINT}.`,
      };
    }

    // Extract asserted tokens against the resolved resource type so the
    // CIDR / name / ingress rules land on the right CFN properties.
    const extraction = extractAssertedValues(safeIntent, output.resourceType);
    if (extraction.errors.length > 0) {
      return {
        userIntent: safeIntent,
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: `Intent validation failed: ${extraction.errors.join(" ")}`,
      };
    }

    // Type safe cast since zod enum is derived from SUPPORTED_TYPES
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.INTENT_PARSED,
      extras: { resourceType: output.resourceType, pattern: null },
    });
    const merged = mergeElicited(state.elicitedOptions, extraction.elicited);
    const mergedPresets = mergePresetFields(
      state.presetFields,
      extraction.elicited,
    );
    return {
      userIntent: safeIntent,
      resourceType: output.resourceType,
      ...(merged !== undefined ? { elicitedOptions: merged } : {}),
      ...(mergedPresets !== undefined ? { presetFields: mergedPresets } : {}),
    };
  };
}

/**
 * Merge parser-asserted values with any pre-existing elicitedOptions
 * (e.g. seeded from checkpoint resume). Parser assertions win only when
 * the key is absent — preserving prior state keeps the "additive only"
 * invariant from Epic 92 wave 2 plan.
 */
function mergeElicited(
  existing: Record<string, unknown> | undefined,
  asserted: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const assertedKeys = Object.keys(asserted);
  if (assertedKeys.length === 0) return existing;
  const base = existing ?? {};
  const merged: Record<string, unknown> = { ...base };
  for (const key of assertedKeys) {
    if (!(key in merged)) merged[key] = asserted[key];
  }
  return merged;
}

/**
 * Scalar asserted values (strings / booleans / numbers) are also mirrored
 * into `presetFields` so the option-elicitor's `applyPresetFields` path
 * (NEVER_ASK policy) propagates them through both the expert and wizard
 * paths without relying on downstream reads of `state.elicitedOptions`.
 *
 * Arrays and object values stay in `elicitedOptions` only — `presetFields`
 * is typed `Record<string, string>` and downstream consumers do their own
 * coercion (`"true"` → `true`). Array values (e.g., SecurityGroupIngress)
 * land in `elicitedOptions` where the LLM plan-merge step picks them up.
 *
 * Keys prefixed with `__` are parser-internal informational hints and are
 * NOT mirrored to presetFields — they are not real CFN properties.
 */
function mergePresetFields(
  existing: Record<string, string> | undefined,
  asserted: Record<string, unknown>,
): Record<string, string> | undefined {
  const base: Record<string, string> = { ...(existing ?? {}) };
  let changed = false;
  for (const [key, value] of Object.entries(asserted)) {
    if (key.startsWith("__")) continue;
    if (key in base) continue;
    if (
      typeof value === "string" ||
      typeof value === "boolean" ||
      typeof value === "number"
    ) {
      base[key] = String(value);
      changed = true;
    }
  }
  if (!changed && existing === undefined) return undefined;
  return base;
}
