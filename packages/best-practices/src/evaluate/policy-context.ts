/**
 * PolicyContext — type-level discriminator for IAM / resource policy documents.
 *
 * Introduced in Epic 99 Wave 3 Lane 3e (W-019 / CT-7) to allow per-antipattern
 * predicates to gate on the *kind* of policy document they are inspecting:
 *
 *   • "trust"    — AWS::IAM::Role.AssumeRolePolicyDocument
 *   • "identity" — AWS::IAM::Policy.PolicyDocument /
 *                  AWS::IAM::ManagedPolicy.PolicyDocument (user/group/role inline)
 *   • "resource" — S3 BucketPolicy / SNS TopicPolicy / KMS KeyPolicy / SQS Policy / etc.
 *
 * The discriminator is derived from (resourceType, propertyPath) at evaluation
 * time via `derivePolicyContext`. Predicates that are context-sensitive (e.g.
 * `cross-account-no-external-id` only applies to trust policies) receive the
 * context and return "not applicable" for irrelevant document kinds rather than
 * potentially spurious findings.
 *
 * Per W2d invariant: unknown (resourceType, propertyPath) combos throw rather
 * than silently falling back — this surfaces misconfigured rules before they
 * reach production manifests.
 */

/* ------------------------------------------------------------------ */
/*  Type                                                               */
/* ------------------------------------------------------------------ */

/**
 * Discriminated union for the three classes of IAM / resource policy
 * document that our BP rules evaluate.
 */
export type PolicyContext =
  /** AWS::IAM::Role.AssumeRolePolicyDocument — trust relationship */
  | { kind: "trust" }
  /** AWS::IAM::Policy.PolicyDocument / AWS::IAM::ManagedPolicy.PolicyDocument */
  | { kind: "identity" }
  /** S3 bucket policy / SNS topic policy / KMS key policy / SQS policy / etc. */
  | { kind: "resource" };

/* ------------------------------------------------------------------ */
/*  Derivation helper                                                   */
/* ------------------------------------------------------------------ */

/**
 * Maps a (resourceType, propertyPath) pair onto a PolicyContext.
 *
 * Trust mappings:
 *   AWS::IAM::Role + AssumeRolePolicyDocument → trust
 *
 * Identity mappings:
 *   AWS::IAM::Policy + PolicyDocument         → identity
 *   AWS::IAM::ManagedPolicy + PolicyDocument  → identity
 *
 * Resource mappings — any other resource type that carries a policy
 * document is treated as a resource policy:
 *   AWS::S3::BucketPolicy + PolicyDocument    → resource
 *   AWS::SNS::TopicPolicy + PolicyDocument    → resource
 *   AWS::SQS::QueuePolicy + PolicyDocument    → resource
 *   AWS::KMS::Key + KeyPolicy                 → resource
 *   AWS::EFS::FileSystemPolicy + PolicyDocument → resource
 *   AWS::OpenSearchService::Domain + AccessPolicies → resource
 *   (and any future resource-policy resource type)
 *
 * Throws for unrecognised (resourceType, propertyPath) combinations that
 * are explicitly expected to carry a policy document but don't match any
 * known mapping. A YAML author who declares `check_type: policy_antipattern`
 * on an unknown combo will see an actionable error rather than a silent pass.
 *
 * @param resourceType  CloudFormation resource type, e.g. "AWS::IAM::Role"
 * @param propertyPath  Property path as declared in the rule YAML, e.g. "AssumeRolePolicyDocument"
 */
export function derivePolicyContext(
  resourceType: string,
  propertyPath: string,
): PolicyContext {
  // Trust policy — only IAM roles can have an AssumeRolePolicyDocument.
  if (
    resourceType === "AWS::IAM::Role" &&
    propertyPath === "AssumeRolePolicyDocument"
  ) {
    return { kind: "trust" };
  }

  // Identity policies — managed/inline policy documents attached to
  // IAM principals (users, groups, roles).
  if (
    (resourceType === "AWS::IAM::Policy" ||
      resourceType === "AWS::IAM::ManagedPolicy") &&
    propertyPath === "PolicyDocument"
  ) {
    return { kind: "identity" };
  }

  // Resource policies — any service-side resource-based policy document.
  // We explicitly enumerate the known types to satisfy the "throw on
  // unrecognised combo" invariant, but treat every non-IAM-identity,
  // non-trust combination as a resource policy for forward-compatibility
  // with future resource types that carry policy documents.
  const knownResourcePolicyTypes = new Set([
    "AWS::S3::BucketPolicy",
    "AWS::SNS::TopicPolicy",
    "AWS::SQS::QueuePolicy",
    "AWS::KMS::Key",
    "AWS::EFS::FileSystemPolicy",
    "AWS::OpenSearchService::Domain",
    "AWS::ElasticsearchService::Domain",
    "AWS::Lambda::Permission",
    "AWS::SecretsManager::ResourcePolicy",
    "AWS::CodeBuild::SourceCredential",
    "AWS::ApiGateway::RestApi",
    "AWS::ApiGatewayV2::Api",
    "AWS::ECR::Repository",
    "AWS::Backup::BackupVault",
    "AWS::Glue::ResourcePolicy",
    "AWS::IoT::Policy",
    "AWS::MediaStore::Container",
    "AWS::SSM::ResourceDataSync",
    "AWS::VpcLattice::ResourcePolicy",
    "AWS::VpcLattice::ServiceNetworkResourcePolicy",
  ]);

  if (knownResourcePolicyTypes.has(resourceType)) {
    return { kind: "resource" };
  }

  // Unrecognised combination — throw so the YAML author gets an
  // actionable error rather than a silent misfire.
  throw new Error(
    `derivePolicyContext: unrecognised (resourceType, propertyPath) combination ` +
      `"${resourceType}" / "${propertyPath}". ` +
      `Register the resource type in policy-context.ts or fix the rule YAML.`,
  );
}
