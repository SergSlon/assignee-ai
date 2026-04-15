import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { CfnKey } from "../../config/cfn-keys.js";
import type { ResourcePlugin } from "../types.js";
import { TAGS_VALIDATE, TAGS_HINT } from "../shared-fields.js";
import { FieldLabel } from "../field-labels.js";

/**
 * ResourcePlugin for AWS::KMS::Key.
 *
 * A customer-managed KMS key (CMK) — the target for every "use a
 * customer-managed key instead of the AWS-managed default" advisory
 * in the codebase: BP-EFS-001, BP-S3-001, BP-RDS-* (and the matching
 * BP-EVENTBUS-001, BP-SNS-001, BP-LOGS-* rules that also reference
 * KmsKeyId fields).
 *
 * CCAPI schema (verified 2026-04-09 via cloudformation:DescribeType):
 *   - primaryIdentifier: /properties/KeyId (auto-generated, readOnly)
 *   - readOnly: /properties/Arn, /properties/KeyId
 *   - required: (none at schema level — every field has a default)
 *   - createOnly: (none — even KeySpec/MultiRegion are update-able on
 *     paper, though most are effectively immutable in practice)
 *   - tagging.taggable = true (taggable on create + update)
 *   - handlers: create, read, update, delete, list (all present)
 *
 * Scope for A11 (2026-04-09):
 *   - Symmetric encryption keys (KeySpec=SYMMETRIC_DEFAULT,
 *     KeyUsage=ENCRYPT_DECRYPT) — the dominant at-rest-encryption
 *     use case. Asymmetric signing/encrypting keys and HMAC keys
 *     are accepted by the wizard via KeySpec but not wizard-
 *     promoted with their own defaults.
 *   - Origin=AWS_KMS (AWS-owned key material). External key
 *     material (EXTERNAL) and CloudHSM-backed (AWS_CLOUDHSM) are
 *     NOT wizard paths — they require an out-of-band import or a
 *     pre-existing cluster, which the assignee plan+apply flow
 *     cannot satisfy. Users who need those paths should provision
 *     the key out-of-band and paste the ARN as a Ref.
 *
 * Pricing: customer-managed KMS keys bill a per-key monthly charge
 * (prorated by the hour) plus per-API-request charges that differ for
 * symmetric encrypt/decrypt vs. asymmetric / data-key generation.
 * Multi-region keys bill once per region. Customer-managed keys with
 * rotation enabled keep old key material around at no extra cost —
 * AWS bills only the current month's storage + request volume.
 * Run `assignee cost` for live Pricing-MCP rates — this plugin does
 * not hardcode dollar amounts (see `feedback_no_hardcoded_prices`).
 */
export const kmsKeyPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.KMS_KEY,
  commonFields: [
    {
      name: "Description",
      question: {
        type: "string",
        label: "Key description",
        placeholder: "Encrypts prod database backups",
        hint: "Strongly recommended. This shows up in the KMS console and in CloudTrail for every Encrypt/Decrypt call — give it a name that tells an oncall engineer what this key is for without having to read the KeyPolicy. KMS keys are indistinguishable by UUID alone.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          if (String(value).length > 8192)
            return "Description must be 8192 characters or fewer";
          return undefined;
        },
      },
    },
    {
      name: "KeyUsage",
      question: {
        type: "enum",
        label: "Key usage",
        hint: "Determines what the key can do. ENCRYPT_DECRYPT (default) covers the at-rest encryption use case that drives every CMK advisory in this CLI. SIGN_VERIFY and GENERATE_VERIFY_MAC are for signature workflows and HMAC-based authentication — don't pick them unless you specifically need them. KEY_AGREEMENT is for ECDH key derivation.",
        options: [
          { value: "ENCRYPT_DECRYPT", label: "Encrypt / decrypt (default)" },
          { value: "SIGN_VERIFY", label: "Sign / verify (asymmetric)" },
          { value: "GENERATE_VERIFY_MAC", label: "HMAC generate / verify" },
          { value: "KEY_AGREEMENT", label: "ECDH key agreement" },
        ],
        initialValue: "ENCRYPT_DECRYPT",
      },
    },
    {
      name: "KeySpec",
      question: {
        type: "enum",
        label: "Key spec",
        hint: "The cryptographic configuration. SYMMETRIC_DEFAULT (AES-256-GCM, default) is what BP-EFS-001/BP-S3-001/BP-RDS-* advisories expect — pick this unless you specifically need asymmetric. Asymmetric RSA/ECC keys are for sign/verify or envelope encryption where the consumer only has the public half. HMAC keys are for MAC-based auth.",
        options: [
          { value: "SYMMETRIC_DEFAULT", label: "Symmetric AES-256 (default)" },
          { value: "RSA_2048", label: "RSA 2048 (asymmetric)" },
          { value: "RSA_3072", label: "RSA 3072 (asymmetric)" },
          { value: "RSA_4096", label: "RSA 4096 (asymmetric)" },
          { value: "ECC_NIST_P256", label: "ECC NIST P-256 (asymmetric)" },
          { value: "ECC_NIST_P384", label: "ECC NIST P-384 (asymmetric)" },
          { value: "ECC_NIST_P521", label: "ECC NIST P-521 (asymmetric)" },
          { value: "ECC_SECG_P256K1", label: "ECC secp256k1 (asymmetric)" },
          { value: "HMAC_224", label: "HMAC SHA-224" },
          { value: "HMAC_256", label: "HMAC SHA-256" },
          { value: "HMAC_384", label: "HMAC SHA-384" },
          { value: "HMAC_512", label: "HMAC SHA-512" },
        ],
        initialValue: "SYMMETRIC_DEFAULT",
      },
    },
    {
      name: "EnableKeyRotation",
      question: {
        type: "boolean",
        label: "Enable automatic key rotation?",
        initialValue: true,
        hint: "Strongly recommended (default true). Automatic annual rotation generates new key material without changing the KeyId — consumers keep working, and the old material is retained for decrypting historical ciphertexts. Only available for SYMMETRIC_DEFAULT keys; ignored for asymmetric + HMAC keys, which must be manually rotated by creating a new key.",
      },
    },
    {
      name: CfnKey.TAGS,
      question: {
        type: "string",
        label: FieldLabel.TAGS,
        placeholder: "env:production, team:platform",
        hint: TAGS_HINT,
        validate: TAGS_VALIDATE,
      },
      toCfn: (answer: unknown) => {
        if (typeof answer !== "string" || !answer.trim()) return undefined;
        const tags = answer
          .split(",")
          .filter((p) => p.includes(":"))
          .map((pair) => {
            const [Key, ...rest] = pair.trim().split(":");
            return { Key: Key!.trim(), Value: rest.join(":").trim() };
          });
        return tags.length > 0 ? tags : undefined;
      },
    },
  ],
  advancedFields: [
    {
      name: "MultiRegion",
      question: {
        type: "boolean",
        label: "Multi-region key?",
        initialValue: false,
        hint: "Create a multi-region primary key that can be replicated to other regions via AWS::KMS::ReplicaKey. Bills once per region. Only useful if you actually need the same key material to decrypt in multiple regions — most workloads do not. Cannot be changed after creation in practice.",
      },
    },
    {
      name: "PendingWindowInDays",
      question: {
        type: "string",
        label: "Pending deletion window (days, 7–30)",
        placeholder: "30",
        hint: "How long KMS waits before permanently deleting a scheduled-for-deletion key. Default 30 (maximum). Minimum 7. Set this higher when the key protects long-lived ciphertexts — during the pending window you can still cancel the deletion and recover the data.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const n = Number(value);
          if (!Number.isInteger(n))
            return "PendingWindowInDays must be an integer";
          if (n < 7 || n > 30)
            return "PendingWindowInDays must be between 7 and 30 days";
          return undefined;
        },
      },
      toCfn: (answer: unknown) => {
        if (answer === undefined || answer === "") return undefined;
        const n = Number(answer);
        return Number.isInteger(n) ? n : undefined;
      },
    },
    {
      name: "KeyPolicy",
      question: {
        type: "string",
        label: "Key policy (JSON)",
        placeholder: '{"Version":"2012-10-17","Statement":[...]}',
        hint: "Optional. JSON resource policy controlling which principals can use (kms:Encrypt/Decrypt/GenerateDataKey) or manage (kms:PutKeyPolicy/ScheduleKeyDeletion) the key. If omitted, KMS attaches a default policy that grants root-account full control — that's the starting point for most CMKs. Override only when you need tight least-privilege scoping.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value).trim();
          try {
            const parsed = JSON.parse(s);
            if (!parsed || typeof parsed !== "object")
              return "Key policy must be a JSON object";
          } catch {
            return "Key policy must be valid JSON";
          }
          return undefined;
        },
      },
      toCfn: (answer: unknown) => {
        if (!answer || (typeof answer === "string" && !answer.trim()))
          return undefined;
        try {
          return JSON.parse(String(answer));
        } catch {
          return undefined;
        }
      },
    },
    {
      name: "Enabled",
      question: {
        type: "boolean",
        label: "Enabled at creation?",
        initialValue: true,
        hint: "Default true. A disabled key cannot encrypt or decrypt — it sits dormant until re-enabled. The only reason to create a disabled key is a staging workflow where you want the ARN to exist before any workload starts depending on it.",
      },
    },
  ],
  defaults: {
    KeyUsage: "ENCRYPT_DECRYPT",
    KeySpec: "SYMMETRIC_DEFAULT",
    EnableKeyRotation: true,
    Enabled: true,
    MultiRegion: false,
  },
  configHints: [
    "Symmetric CMKs with EnableKeyRotation=true are the default — they satisfy BP-EFS-001, BP-S3-001, BP-RDS-*, BP-EVENTBUS-001, BP-SNS-001 and every other 'use a customer-managed key' advisory.",
    "Do NOT set KeySpec=RSA_* or ECC_* for an at-rest-encryption use case — asymmetric keys can encrypt at most 4096 bytes and are NOT accepted by service integrations like EFS, S3, RDS, or Secrets Manager.",
    "EnableKeyRotation applies only to SYMMETRIC_DEFAULT keys. For asymmetric and HMAC keys, CCAPI silently ignores the field — manual rotation is done by creating a new key and updating consumers.",
    "Omitting KeyPolicy is the right default — KMS attaches a root-account-full-control policy that the root user can then delegate via IAM. Only override when you need strict least-privilege scoping, and be careful: a malformed policy can lock the key (use BypassPolicyLockoutSafetyCheck=false so CCAPI refuses lockouts at create time).",
    "PendingWindowInDays defaults to 30 (the maximum) for safety. Schedule-for-deletion is reversible during this window — a lower value speeds cleanup for throwaway keys but removes the safety net for long-lived encryption material.",
    "Multi-region keys bill the per-key monthly rate PER REGION and need a separate AWS::KMS::ReplicaKey resource in each target region. Default false — only enable if you've actually modeled the cross-region decrypt path. Run `assignee cost` for live Pricing-MCP rates.",
    "KMS keys are charged a per-key monthly rate regardless of usage (prorated to the hour) plus per-request API charges (symmetric encrypt/decrypt is cheaper than asymmetric / GenerateDataKey). Delete throwaway keys promptly to avoid idle charges. Run `assignee cost` for live Pricing-MCP rates.",
  ],
};
