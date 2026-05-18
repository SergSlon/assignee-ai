import { describe, it, expect } from "vitest";
import {
  ErrorHintRegistry,
  defaultErrorHintRegistry,
} from "./hint-registry.js";
import { ProvisioningError, AssigneeError } from "../errors.js";

describe("ErrorHintRegistry", () => {
  it("returns the registered hint for a known ProvisioningErrorCode", () => {
    const hint = defaultErrorHintRegistry.getHint(
      new ProvisioningError("Resource already exists", "AlreadyExists"),
    );
    expect(hint).toBe(
      "A resource with this name already exists. Try a different name.",
    );
  });

  it("returns hint for Throttled code", () => {
    const hint = defaultErrorHintRegistry.getHint(
      new ProvisioningError("Throttled", "Throttled"),
    );
    expect(hint).toBe("AWS is throttling requests. Wait 30 seconds and retry.");
  });

  it("returns hint for StateMismatch code", () => {
    const hint = defaultErrorHintRegistry.getHint(
      new ProvisioningError("Stale plan", "StateMismatch"),
    );
    expect(hint).toBe(
      "Resource already exists. Choose a different name and re-run 'assignee infra plan'.",
    );
  });

  it("returns hint for NotFound code", () => {
    const hint = defaultErrorHintRegistry.getHint(
      new ProvisioningError("Not found", "NotFound"),
    );
    expect(hint).toBe(
      "Resource was removed during provisioning. Re-run `assignee infra plan` to get a fresh plan.",
    );
  });

  it("returns undefined for Unknown ProvisioningErrorCode (no hint registered)", () => {
    const hint = defaultErrorHintRegistry.getHint(
      new ProvisioningError("Unknown error", "Unknown"),
    );
    expect(hint).toBeUndefined();
  });

  it("returns undefined for a non-ProvisioningError AssigneeError", () => {
    const hint = defaultErrorHintRegistry.getHint(
      new AssigneeError("Some generic error", "GENERIC"),
    );
    expect(hint).toBeUndefined();
  });

  it("returns undefined when error is undefined", () => {
    const hint = defaultErrorHintRegistry.getHint(undefined);
    expect(hint).toBeUndefined();
  });

  it("supports custom registries with custom hints", () => {
    const registry = new ErrorHintRegistry();
    registry.register("AlreadyExists", "Custom: try a different name.");
    const hint = registry.getHint(
      new ProvisioningError("Already exists", "AlreadyExists"),
    );
    expect(hint).toBe("Custom: try a different name.");
  });

  it("returns undefined for unregistered codes in a fresh registry", () => {
    const registry = new ErrorHintRegistry();
    const hint = registry.getHint(
      new ProvisioningError("Not registered", "NotFound"),
    );
    expect(hint).toBeUndefined();
  });
});
