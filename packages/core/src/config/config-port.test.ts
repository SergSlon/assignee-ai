import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvVar } from "../constants/env-vars.js";
import { ProcessEnvConfigAdapter, type ConfigPort } from "./config-port.js";

/**
 * Tests for ConfigPort + ProcessEnvConfigAdapter (MASTER-009 RW4b-1).
 *
 * Covers all four accessor methods, default-fallback paths, parse errors,
 * per-instance cache isolation, and EnvVar enum interop. Mutations to
 * `process.env` are restored in `afterEach` to keep test runs hermetic
 * and prevent leakage into adjacent tests in the suite.
 */

const TEST_KEY_STRING = "ASSIGNEE_TEST_CONFIG_PORT_STRING";
const TEST_KEY_INT = "ASSIGNEE_TEST_CONFIG_PORT_INT";
const TEST_KEY_BOOL = "ASSIGNEE_TEST_CONFIG_PORT_BOOL";
const TEST_KEY_REQUIRED = "ASSIGNEE_TEST_CONFIG_PORT_REQUIRED";
const TEST_KEY_INSTANCE_A = "ASSIGNEE_TEST_CONFIG_PORT_INSTANCE_A";
const TEST_KEY_INSTANCE_B = "ASSIGNEE_TEST_CONFIG_PORT_INSTANCE_B";
const TEST_KEY_WARN = "ASSIGNEE_TEST_CONFIG_PORT_WARN";

const ALL_TEST_KEYS = [
  TEST_KEY_STRING,
  TEST_KEY_INT,
  TEST_KEY_BOOL,
  TEST_KEY_REQUIRED,
  TEST_KEY_INSTANCE_A,
  TEST_KEY_INSTANCE_B,
  TEST_KEY_WARN,
  EnvVar.ASSIGNEE_LLM_DEFAULT,
];

function clearTestKeys(): void {
  for (const k of ALL_TEST_KEYS) {
    // eslint-disable-next-line @typescript-eslint/dot-notation
    delete process.env[k];
  }
}

beforeEach(() => {
  clearTestKeys();
});

afterEach(() => {
  clearTestKeys();
  vi.restoreAllMocks();
});

describe("ProcessEnvConfigAdapter.get", () => {
  it("returns env-var value when set", () => {
    // eslint-disable-next-line @typescript-eslint/dot-notation
    process.env[TEST_KEY_STRING] = "hello-world";
    const port: ConfigPort = new ProcessEnvConfigAdapter();
    expect(port.get(TEST_KEY_STRING)).toBe("hello-world");
  });

  it("returns defaultValue when env unset", () => {
    const port = new ProcessEnvConfigAdapter();
    expect(port.get(TEST_KEY_STRING, "fallback-default")).toBe(
      "fallback-default",
    );
  });

  it("returns undefined when env unset and no default provided", () => {
    const port = new ProcessEnvConfigAdapter();
    expect(port.get(TEST_KEY_STRING)).toBeUndefined();
  });

  it("treats empty string as a set value (does NOT fall back)", () => {
    // Mirrors process.env semantics — only `undefined` (key never assigned)
    // counts as unset; empty string is a deliberate value.
    // eslint-disable-next-line @typescript-eslint/dot-notation
    process.env[TEST_KEY_STRING] = "";
    const port = new ProcessEnvConfigAdapter();
    expect(port.get(TEST_KEY_STRING, "fallback")).toBe("");
  });
});

describe("ProcessEnvConfigAdapter.getRequired", () => {
  it("returns env-var value when set", () => {
    // eslint-disable-next-line @typescript-eslint/dot-notation
    process.env[TEST_KEY_REQUIRED] = "must-have-value";
    const port = new ProcessEnvConfigAdapter();
    expect(port.getRequired(TEST_KEY_REQUIRED)).toBe("must-have-value");
  });

  it("throws an Error mentioning the key when env is unset", () => {
    const port = new ProcessEnvConfigAdapter();
    expect(() => port.getRequired(TEST_KEY_REQUIRED)).toThrowError(
      new RegExp(TEST_KEY_REQUIRED),
    );
  });
});

describe("ProcessEnvConfigAdapter.getInt", () => {
  it("parses a numeric string", () => {
    // eslint-disable-next-line @typescript-eslint/dot-notation
    process.env[TEST_KEY_INT] = "42";
    const port = new ProcessEnvConfigAdapter();
    expect(port.getInt(TEST_KEY_INT)).toBe(42);
  });

  it("parses negative integers", () => {
    // eslint-disable-next-line @typescript-eslint/dot-notation
    process.env[TEST_KEY_INT] = "-7";
    const port = new ProcessEnvConfigAdapter();
    expect(port.getInt(TEST_KEY_INT)).toBe(-7);
  });

  it("returns default on non-numeric value", () => {
    // eslint-disable-next-line @typescript-eslint/dot-notation
    process.env[TEST_KEY_INT] = "not-a-number";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const port = new ProcessEnvConfigAdapter();
    expect(port.getInt(TEST_KEY_INT, 99)).toBe(99);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("returns undefined on non-numeric value with no default", () => {
    // eslint-disable-next-line @typescript-eslint/dot-notation
    process.env[TEST_KEY_INT] = "garbage";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const port = new ProcessEnvConfigAdapter();
    expect(port.getInt(TEST_KEY_INT)).toBeUndefined();
  });

  it("returns default when env unset", () => {
    const port = new ProcessEnvConfigAdapter();
    expect(port.getInt(TEST_KEY_INT, 12)).toBe(12);
  });
});

describe("ProcessEnvConfigAdapter.getBool", () => {
  it.each(["1", "true", "TRUE", "yes", "Yes", "on", "ON"])(
    'parses "%s" as true',
    (raw) => {
      // eslint-disable-next-line @typescript-eslint/dot-notation
      process.env[TEST_KEY_BOOL] = raw;
      const port = new ProcessEnvConfigAdapter();
      expect(port.getBool(TEST_KEY_BOOL)).toBe(true);
    },
  );

  it.each(["0", "false", "FALSE", "no", "No", "off", "OFF"])(
    'parses "%s" as false',
    (raw) => {
      // eslint-disable-next-line @typescript-eslint/dot-notation
      process.env[TEST_KEY_BOOL] = raw;
      const port = new ProcessEnvConfigAdapter();
      expect(port.getBool(TEST_KEY_BOOL)).toBe(false);
    },
  );

  it("returns default on unparseable value", () => {
    // eslint-disable-next-line @typescript-eslint/dot-notation
    process.env[TEST_KEY_BOOL] = "maybe";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const port = new ProcessEnvConfigAdapter();
    expect(port.getBool(TEST_KEY_BOOL, true)).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("returns undefined on unparseable value with no default", () => {
    // eslint-disable-next-line @typescript-eslint/dot-notation
    process.env[TEST_KEY_BOOL] = "perhaps";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const port = new ProcessEnvConfigAdapter();
    expect(port.getBool(TEST_KEY_BOOL)).toBeUndefined();
  });

  it("warns at most once per key per instance", () => {
    // eslint-disable-next-line @typescript-eslint/dot-notation
    process.env[TEST_KEY_WARN] = "huh";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const port = new ProcessEnvConfigAdapter();
    port.getBool(TEST_KEY_WARN, false);
    port.getBool(TEST_KEY_WARN, false);
    port.getBool(TEST_KEY_WARN, false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("returns default when env unset", () => {
    const port = new ProcessEnvConfigAdapter();
    expect(port.getBool(TEST_KEY_BOOL, false)).toBe(false);
  });
});

describe("per-instance cache isolation", () => {
  it("two ConfigPort instances do not share cached values", () => {
    // eslint-disable-next-line @typescript-eslint/dot-notation
    process.env[TEST_KEY_INSTANCE_A] = "from-A";
    const portA = new ProcessEnvConfigAdapter();
    expect(portA.get(TEST_KEY_INSTANCE_A)).toBe("from-A");

    // Now mutate env BEFORE instance B reads — instance A has cached
    // "from-A", instance B starts fresh and observes the new value.
    // eslint-disable-next-line @typescript-eslint/dot-notation
    process.env[TEST_KEY_INSTANCE_A] = "from-B";
    const portB = new ProcessEnvConfigAdapter();

    expect(portA.get(TEST_KEY_INSTANCE_A)).toBe("from-A"); // cached
    expect(portB.get(TEST_KEY_INSTANCE_A)).toBe("from-B"); // fresh read
  });

  it("warning state is per-instance — second instance re-warns", () => {
    // eslint-disable-next-line @typescript-eslint/dot-notation
    process.env[TEST_KEY_INSTANCE_B] = "junk";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const portA = new ProcessEnvConfigAdapter();
    const portB = new ProcessEnvConfigAdapter();
    portA.getInt(TEST_KEY_INSTANCE_B, 0);
    portA.getInt(TEST_KEY_INSTANCE_B, 0); // suppressed on A
    portB.getInt(TEST_KEY_INSTANCE_B, 0); // fresh on B → warns
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});

describe("EnvVar enum interop", () => {
  it("looks up values keyed by EnvVar enum strings", () => {
    // eslint-disable-next-line @typescript-eslint/dot-notation
    process.env[EnvVar.ASSIGNEE_LLM_DEFAULT] =
      "anthropic.claude-3-5-sonnet-20241022-v2:0";
    const port = new ProcessEnvConfigAdapter();
    expect(port.get(EnvVar.ASSIGNEE_LLM_DEFAULT)).toBe(
      "anthropic.claude-3-5-sonnet-20241022-v2:0",
    );
  });
});
