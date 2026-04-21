/**
 * Facade for the AWS::EC2::Instance plugin. Implementation is split
 * across `./ec2-instance/` for SRP — see fields.ts (field defs),
 * user-data.ts (base64 classification + encoding), config.ts (defaults +
 * companion SecurityGroup resolver + configHints), and index.ts (plugin
 * assembly).
 *
 * Re-exports preserve all consumer import paths (`./ec2-instance.js`).
 *
 * Epic 92 Wave 4.b (finding C-16): "CPU Credits" plan row rendered with an
 * empty value when the user didn't supply CreditSpecification (and the
 * instance was a t3/t4g burstable type, the only family where the field
 * applies). The friendly-name map in `utils/display-helpers/friendly-names.ts`
 * shows `CreditSpecification → "CPU Credits"`, so the row existed but had
 * no value to display, which looked broken to dogfood users.
 *
 * This facade seeds a plan-time default of `{ CpuCredits: "standard" }`
 * on top of the inner plugin's static `defaults` object. `"standard"` is
 * the AWS default for all burstable types and matches the field's own
 * `initialValue: "standard"` in `fields.ts`, so the value is consistent
 * across wizard elicitation, LLM prompts, and the plan-time display.
 *
 * Scope is intentionally narrow — only `CreditSpecification` is mutated
 * here. All other EC2 defaults (IMDSv2, encrypted EBS, termination
 * protection, EBS optimisation) continue to live inside `./ec2-instance/
 * config.ts` where they belong; the CPU-credit default lands here because
 * Wave 4.b's file-ownership matrix restricts this story to the facade.
 */
import { ec2InstancePlugin as innerPlugin } from "./ec2-instance/index.js";
import { CfnKey } from "../../config/cfn-keys.js";

// Seed CPU-credit default without clobbering existing defaults. The inner
// plugin's `defaults` object is a plain Record — we mutate it in place so
// every consumer of `ec2InstancePlugin.defaults` (compound plan injection,
// required-field repair, plan display) sees the additional entry.
if (innerPlugin.defaults[CfnKey.CREDIT_SPECIFICATION] === undefined) {
  innerPlugin.defaults[CfnKey.CREDIT_SPECIFICATION] = {
    CpuCredits: "standard",
  };
}

export {
  ec2InstancePlugin,
  INSTANCE_CATEGORIES,
  classifyUserData,
  encodeUserData,
} from "./ec2-instance/index.js";
