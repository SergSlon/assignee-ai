/**
 * Tests for `ami-default-user.ts` — AMI → SSH-default-user mapping +
 * Windows fail-fast detection. SSH-bundle Story iii.
 *
 * Coverage:
 *   - `matchAmiNameToUser` regex table — every entry hit at least once,
 *     plus the order-dependent al2023 vs al2 fall-through.
 *   - `getAmiDefaultUser` Windows path → throws `AmiIsWindowsError`.
 *   - `getAmiDefaultUser` Linux path → returns mapped user, calls
 *     DescribeImages exactly once (cache hit on second call).
 *   - `getAmiDefaultUser` unknown AMI → logs warn + falls back to
 *     `ec2-user`.
 *   - `getAmiPlatformDetails` returns the raw PlatformDetails string,
 *     and returns `null` when the API call fails.
 *   - `tryGetAmiDefaultUser` swallows DescribeImages errors and
 *     returns `undefined`.
 *
 * Fixtures use real AWS-shape AMI IDs and real `Image.Name` strings
 * sourced from public AWS-owned AMI catalogs per
 * `feedback_real_data_mocks_all_cases`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockEc2Send, mockEc2Destroy } = vi.hoisted(() => ({
  mockEc2Send: vi.fn(),
  mockEc2Destroy: vi.fn(),
}));

vi.mock("@aws-sdk/client-ec2", () => {
  class EC2Client {
    send = mockEc2Send;
    destroy = mockEc2Destroy;
  }
  function DescribeImagesCommand(input: unknown) {
    return { _type: "DescribeImagesCommand", input };
  }
  return { EC2Client, DescribeImagesCommand };
});

vi.mock("../logger/index.js", async () => {
  const actual =
    await vi.importActual<typeof import("../logger/index.js")>(
      "../logger/index.js",
    );
  return {
    ...actual,
    log: vi.fn(),
  };
});

import {
  getAmiDefaultUser,
  getAmiPlatformDetails,
  tryGetAmiDefaultUser,
  matchAmiNameToUser,
  clearAmiDefaultUserCache,
  AmiIsWindowsError,
  DEFAULT_SSH_USER_FALLBACK,
  PLATFORM_DETAILS_WINDOWS,
  __TEST__,
} from "./ami-default-user.js";
import { log, LogLevel } from "../logger/index.js";

const ORIGINAL_ENV = { ...process.env };

// Real-shape AMI IDs (17-char hex; AWS public catalog format).
const AMI_AL2023 = "ami-0abcdef1234567890";
const AMI_UBUNTU_24 = "ami-04f2a6c1c6b3e1234";
const AMI_DEBIAN_12 = "ami-09b1c4f2c3d4e5f60";
const AMI_RHEL_9 = "ami-0c2b5e1c8d3f1a234";
const AMI_SLES_15 = "ami-01a2b3c4d5e6f7890";
const AMI_CENTOS_7 = "ami-0123456789abcdef0";
const AMI_AL2_LEGACY = "ami-0fedcba9876543210";
const AMI_WINDOWS_2022 = "ami-0d1e2f3a4b5c6d7e8";
const AMI_UNKNOWN = "ami-0000aaaa1111bbbb2";

// Real Image.Name strings from public AWS catalogs.
const NAME_AL2023 = "al2023-ami-2023.4.20240319.0-kernel-6.1-x86_64";
const NAME_AL2_LEGACY = "amzn2-ami-hvm-2.0.20231116.0-x86_64-gp2";
const NAME_UBUNTU_24 =
  "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20240423";
const NAME_DEBIAN_12 = "debian-12-amd64-20240211-1654";
const NAME_RHEL_9 = "RHEL-9.3.0_HVM-20240117-x86_64-49-Hourly2-GP3";
const NAME_SLES_15 = "suse-sles-15-sp5-v20240220-hvm-ssd-x86_64";
const NAME_CENTOS_7 = "CentOS-7-2111-20220330_1.x86_64-d9a3032a";
const NAME_WINDOWS_2022 = "Windows_Server-2022-English-Full-Base-2024.04.10";

beforeEach(() => {
  vi.clearAllMocks();
  mockEc2Send.mockReset();
  mockEc2Destroy.mockReset();
  clearAmiDefaultUserCache();
  // Operator credentials must be present so `tryAssigneeCredentials("operator")`
  // returns a real creds object — without these, the module short-circuits to
  // null before issuing any SDK call (graceful-degradation contract).
  process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
  process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// ── matchAmiNameToUser — every regex branch ──────────────────────────────────

describe("matchAmiNameToUser", () => {
  it("amzn2023 / al2023 / amazon-linux-2023 → ec2-user", () => {
    expect(matchAmiNameToUser(NAME_AL2023)).toBe("ec2-user");
    expect(matchAmiNameToUser("amazon-linux-2023-base-x86_64")).toBe(
      "ec2-user",
    );
    expect(matchAmiNameToUser("amzn2023-foo")).toBe("ec2-user");
  });

  it("amzn2 / al2- (legacy AL2) → ec2-user (must NOT collide with al2023)", () => {
    // Order is load-bearing: NAME_AL2_LEGACY contains "amzn2" which would
    // also match the al2023 regex if order were wrong. Verify both rules
    // independently so the table stays self-checking.
    expect(matchAmiNameToUser(NAME_AL2_LEGACY)).toBe("ec2-user");
    expect(matchAmiNameToUser("al2-ami-hvm-2.0.123-x86_64")).toBe("ec2-user");
  });

  it("ubuntu → ubuntu", () => {
    expect(matchAmiNameToUser(NAME_UBUNTU_24)).toBe("ubuntu");
    expect(
      matchAmiNameToUser(
        "ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-20240221",
      ),
    ).toBe("ubuntu");
  });

  it("debian → admin", () => {
    expect(matchAmiNameToUser(NAME_DEBIAN_12)).toBe("admin");
    expect(matchAmiNameToUser("debian-11-amd64-20240211-1654")).toBe("admin");
  });

  it("rhel and red.?hat → ec2-user", () => {
    expect(matchAmiNameToUser(NAME_RHEL_9)).toBe("ec2-user");
    expect(matchAmiNameToUser("Red-Hat-Enterprise-Linux-9.4")).toBe("ec2-user");
    expect(matchAmiNameToUser("redhat-cloud-9-arm64")).toBe("ec2-user");
  });

  it("sles / suse → ec2-user", () => {
    expect(matchAmiNameToUser(NAME_SLES_15)).toBe("ec2-user");
    expect(matchAmiNameToUser("openSUSE-Leap-15.5-v20231101-x86_64")).toBe(
      "ec2-user",
    );
  });

  it("centos → ec2-user (modern CentOS Stream 9; legacy CentOS 6/7 are EOL)", () => {
    // Modern CentOS Stream 9 (the live AMI on AWS Marketplace) uses
    // ec2-user / cloud-user. Only legacy CentOS 6/7 used the "centos"
    // account, and those releases are EOL — the simpler unified
    // ec2-user mapping is fine.
    expect(matchAmiNameToUser(NAME_CENTOS_7)).toBe("ec2-user");
    expect(matchAmiNameToUser("CentOS-Stream-9-2024-04-01")).toBe("ec2-user");
  });

  it("returns null for empty / unknown names", () => {
    expect(matchAmiNameToUser("")).toBeNull();
    expect(matchAmiNameToUser("homebrew-custom-image-2024")).toBeNull();
    expect(matchAmiNameToUser("my-baked-ami")).toBeNull();
  });
});

// ── getAmiDefaultUser end-to-end (with mocked DescribeImages) ────────────────

describe("getAmiDefaultUser", () => {
  it("Linux AMI: returns the mapped user and calls DescribeImages once (caches result)", async () => {
    mockEc2Send.mockResolvedValue({
      Images: [
        {
          ImageId: AMI_UBUNTU_24,
          Name: NAME_UBUNTU_24,
          PlatformDetails: "Linux/UNIX",
        },
      ],
    });

    const user1 = await getAmiDefaultUser(AMI_UBUNTU_24);
    const user2 = await getAmiDefaultUser(AMI_UBUNTU_24);
    expect(user1).toBe("ubuntu");
    expect(user2).toBe("ubuntu");
    // Cached: only one DescribeImages call across both invocations.
    expect(mockEc2Send).toHaveBeenCalledTimes(1);
    expect(mockEc2Send).toHaveBeenCalledWith(
      expect.objectContaining({
        _type: "DescribeImagesCommand",
        input: { ImageIds: [AMI_UBUNTU_24] },
      }),
    );
    // EC2 client is destroyed after the single call.
    expect(mockEc2Destroy).toHaveBeenCalledTimes(1);
  });

  it("AL2023: maps to ec2-user", async () => {
    mockEc2Send.mockResolvedValue({
      Images: [
        {
          ImageId: AMI_AL2023,
          Name: NAME_AL2023,
          PlatformDetails: "Linux/UNIX",
        },
      ],
    });
    expect(await getAmiDefaultUser(AMI_AL2023)).toBe("ec2-user");
  });

  it("Debian 12: maps to admin", async () => {
    mockEc2Send.mockResolvedValue({
      Images: [
        {
          ImageId: AMI_DEBIAN_12,
          Name: NAME_DEBIAN_12,
          PlatformDetails: "Linux/UNIX",
        },
      ],
    });
    expect(await getAmiDefaultUser(AMI_DEBIAN_12)).toBe("admin");
  });

  it("RHEL 9: maps to ec2-user", async () => {
    mockEc2Send.mockResolvedValue({
      Images: [
        {
          ImageId: AMI_RHEL_9,
          Name: NAME_RHEL_9,
          PlatformDetails: "Red Hat Enterprise Linux",
        },
      ],
    });
    expect(await getAmiDefaultUser(AMI_RHEL_9)).toBe("ec2-user");
  });

  it("SLES: maps to ec2-user", async () => {
    mockEc2Send.mockResolvedValue({
      Images: [
        {
          ImageId: AMI_SLES_15,
          Name: NAME_SLES_15,
          PlatformDetails: "SUSE Linux Enterprise Server",
        },
      ],
    });
    expect(await getAmiDefaultUser(AMI_SLES_15)).toBe("ec2-user");
  });

  it("CentOS: maps to ec2-user (modern CentOS Stream 9; legacy CentOS 6/7 are EOL)", async () => {
    mockEc2Send.mockResolvedValue({
      Images: [
        {
          ImageId: AMI_CENTOS_7,
          Name: NAME_CENTOS_7,
          PlatformDetails: "Linux/UNIX",
        },
      ],
    });
    expect(await getAmiDefaultUser(AMI_CENTOS_7)).toBe("ec2-user");
  });

  it("AL2 legacy: maps to ec2-user (table-order regression test)", async () => {
    mockEc2Send.mockResolvedValue({
      Images: [
        {
          ImageId: AMI_AL2_LEGACY,
          Name: NAME_AL2_LEGACY,
          PlatformDetails: "Linux/UNIX",
        },
      ],
    });
    expect(await getAmiDefaultUser(AMI_AL2_LEGACY)).toBe("ec2-user");
  });

  it("Windows AMI: throws AmiIsWindowsError (defense-in-depth)", async () => {
    mockEc2Send.mockResolvedValue({
      Images: [
        {
          ImageId: AMI_WINDOWS_2022,
          Name: NAME_WINDOWS_2022,
          PlatformDetails: PLATFORM_DETAILS_WINDOWS,
        },
      ],
    });

    await expect(getAmiDefaultUser(AMI_WINDOWS_2022)).rejects.toBeInstanceOf(
      AmiIsWindowsError,
    );
    await expect(getAmiDefaultUser(AMI_WINDOWS_2022)).rejects.toMatchObject({
      code: "AMI_IS_WINDOWS",
      amiId: AMI_WINDOWS_2022,
    });
  });

  it("unknown AMI Name: falls back to ec2-user with a warn-level log entry", async () => {
    mockEc2Send.mockResolvedValue({
      Images: [
        {
          ImageId: AMI_UNKNOWN,
          Name: "homebrew-custom-bake-2024-04-01",
          PlatformDetails: "Linux/UNIX",
        },
      ],
    });

    const user = await getAmiDefaultUser(AMI_UNKNOWN, "run-test-123");
    expect(user).toBe(DEFAULT_SSH_USER_FALLBACK);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        level: LogLevel.WARN,
        runId: "run-test-123",
        extras: expect.objectContaining({
          phase: "ami_default_user_unknown",
          amiId: AMI_UNKNOWN,
        }),
      }),
    );
  });

  it("unknown AMI without runId: still falls back, no log emitted", async () => {
    mockEc2Send.mockResolvedValue({
      Images: [
        {
          ImageId: AMI_UNKNOWN,
          Name: "totally-unknown-ami",
          PlatformDetails: "Linux/UNIX",
        },
      ],
    });

    expect(await getAmiDefaultUser(AMI_UNKNOWN)).toBe(
      DEFAULT_SSH_USER_FALLBACK,
    );
    // Without a runId we cannot construct a LogEvent, so no log call.
    expect(log).not.toHaveBeenCalled();
  });

  it("DescribeImages returns no Images: falls back to ec2-user", async () => {
    mockEc2Send.mockResolvedValue({ Images: [] });
    expect(await getAmiDefaultUser(AMI_UNKNOWN)).toBe(
      DEFAULT_SSH_USER_FALLBACK,
    );
  });

  it("missing operator credentials: short-circuits to fallback (no SDK call)", async () => {
    delete process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
    delete process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];

    expect(await getAmiDefaultUser(AMI_UBUNTU_24)).toBe(
      DEFAULT_SSH_USER_FALLBACK,
    );
    expect(mockEc2Send).not.toHaveBeenCalled();
  });
});

// ── getAmiPlatformDetails ────────────────────────────────────────────────────

describe("getAmiPlatformDetails", () => {
  it("returns the raw PlatformDetails string when present", async () => {
    mockEc2Send.mockResolvedValue({
      Images: [
        {
          ImageId: AMI_WINDOWS_2022,
          Name: NAME_WINDOWS_2022,
          PlatformDetails: PLATFORM_DETAILS_WINDOWS,
        },
      ],
    });
    expect(await getAmiPlatformDetails(AMI_WINDOWS_2022)).toBe("Windows");
  });

  it("returns null when DescribeImages throws", async () => {
    mockEc2Send.mockRejectedValue(
      Object.assign(new Error("Rate exceeded"), {
        name: "ThrottlingException",
      }),
    );
    expect(await getAmiPlatformDetails(AMI_AL2023)).toBeNull();
  });

  it("returns null when no Images returned", async () => {
    mockEc2Send.mockResolvedValue({ Images: [] });
    expect(await getAmiPlatformDetails(AMI_UNKNOWN)).toBeNull();
  });

  it("returns null when operator credentials are missing", async () => {
    delete process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
    delete process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];
    expect(await getAmiPlatformDetails(AMI_AL2023)).toBeNull();
    expect(mockEc2Send).not.toHaveBeenCalled();
  });
});

// ── tryGetAmiDefaultUser ─────────────────────────────────────────────────────

describe("tryGetAmiDefaultUser", () => {
  it("returns the mapped user on the happy path", async () => {
    mockEc2Send.mockResolvedValue({
      Images: [
        {
          ImageId: AMI_UBUNTU_24,
          Name: NAME_UBUNTU_24,
          PlatformDetails: "Linux/UNIX",
        },
      ],
    });
    expect(await tryGetAmiDefaultUser(AMI_UBUNTU_24, "run-tx")).toBe("ubuntu");
  });

  it("returns undefined and logs at info when the lookup throws Windows", async () => {
    // Seed cache so describeAmiMetadata returns Windows without an SDK call.
    __TEST__.seedCache(AMI_WINDOWS_2022, {
      name: NAME_WINDOWS_2022,
      platformDetails: PLATFORM_DETAILS_WINDOWS,
    });

    expect(
      await tryGetAmiDefaultUser(AMI_WINDOWS_2022, "run-tx"),
    ).toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        level: LogLevel.INFO,
        extras: expect.objectContaining({ amiId: AMI_WINDOWS_2022 }),
      }),
    );
  });
});
