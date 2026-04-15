/**
 * Shared command execution skeleton for plan and apply commands.
 *
 * Wave 6d F5: barrel after decomposition into ./command-runner/*:
 *   - credentials.ts     — early credential detection + auto-promotion
 *   - llm-factory.ts     — LlmAdapter / RoutingLlmAdapter / recorder wrap
 *   - runner.ts          — bootstrap (MCP + graph + intro/outro/error)
 *   - provision-loop.ts  — Phase 2 provisioning loop
 *
 * Credential resolution order (highest to lowest priority):
 *   1. ASSIGNEE_OPERATOR_ACCESS_KEY_ID + ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY
 *   2. AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (auto-promoted with warning)
 *   3. None — fail with a clear ConfigurationError
 *
 * AWS_PROFILE alone is NOT supported because we need to mint long-lived
 * credentials for the operator role; profile-based STS sessions don't
 * provide that lifetime guarantee. Run `assignee setup` to create the
 * 3 IAM users with explicit access keys.
 */
export {
  runCommand,
  type CommandContext,
  type RunCommandOptions,
} from "./command-runner/runner.js";
export { runProvisioningLoop } from "./command-runner/provision-loop.js";
