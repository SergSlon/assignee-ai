import { describe, it, expect } from "vitest";
import {
  extractEmail,
  extractAllEmails,
  isWellFormedEmail,
} from "./email-extractor.js";

describe("isWellFormedEmail", () => {
  it("accepts simple address", () => {
    expect(isWellFormedEmail("alice@example.com")).toBe(true);
  });

  it("accepts address with dots and plus in local-part", () => {
    expect(isWellFormedEmail("liamin.web+tag@gmail.com")).toBe(true);
  });

  it("accepts multi-segment domain", () => {
    expect(isWellFormedEmail("user@mail.example.co.uk")).toBe(true);
  });

  it("accepts hyphen in domain label", () => {
    expect(isWellFormedEmail("bob@my-company.io")).toBe(true);
  });

  it("rejects missing @", () => {
    expect(isWellFormedEmail("notanemail")).toBe(false);
  });

  it("rejects leading dot in local-part", () => {
    expect(isWellFormedEmail(".user@example.com")).toBe(false);
  });

  it("rejects trailing dot in local-part", () => {
    expect(isWellFormedEmail("user.@example.com")).toBe(false);
  });

  it("rejects consecutive dots", () => {
    expect(isWellFormedEmail("us..er@example.com")).toBe(false);
  });

  it("rejects single-character TLD", () => {
    expect(isWellFormedEmail("user@example.c")).toBe(false);
  });

  it("rejects domain label starting with hyphen", () => {
    expect(isWellFormedEmail("user@-example.com")).toBe(false);
  });

  it("rejects domain label ending with hyphen", () => {
    expect(isWellFormedEmail("user@example-.com")).toBe(false);
  });

  it("rejects no domain part", () => {
    expect(isWellFormedEmail("user@")).toBe(false);
  });
});

describe("extractEmail", () => {
  it("extracts email from 'with email subscription to' phrase", () => {
    expect(
      extractEmail(
        "Create an SNS topic with email subscription to alice@example.com",
      ),
    ).toBe("alice@example.com");
  });

  it("extracts email from 'with subscriber' phrase", () => {
    expect(extractEmail("SNS topic with subscriber liamin.web@gmail.com")).toBe(
      "liamin.web@gmail.com",
    );
  });

  it("extracts email with plus in local-part", () => {
    expect(
      extractEmail(
        "Create SNS with email subscription to bob+alerts@example.org",
      ),
    ).toBe("bob+alerts@example.org");
  });

  it("returns null when no email present", () => {
    expect(extractEmail("Create an SNS topic")).toBeNull();
  });

  it("returns null for bare word that looks like email but is not", () => {
    expect(
      extractEmail("Create an SNS topic with email subscription to notanemail"),
    ).toBeNull();
  });

  it("returns null for token missing TLD", () => {
    expect(extractEmail("subscribe alice@example")).toBeNull();
  });

  it("returns the first valid email when multiple are present", () => {
    expect(
      extractEmail("SNS topic with subscriptions to alice@a.com and bob@b.com"),
    ).toBe("alice@a.com");
  });
});

describe("extractAllEmails", () => {
  it("returns empty array when no emails present", () => {
    expect(extractAllEmails("Create an SNS topic")).toEqual([]);
  });

  it("returns single email in array", () => {
    expect(extractAllEmails("with subscriber alice@example.com")).toEqual([
      "alice@example.com",
    ]);
  });

  it("returns all valid emails when multiple present", () => {
    const result = extractAllEmails(
      "SNS topic with subscriptions to alice@a.com and bob@b.com",
    );
    expect(result).toEqual(["alice@a.com", "bob@b.com"]);
  });

  it("filters out invalid email tokens", () => {
    const result = extractAllEmails(
      "subscribe notanemail and alice@example.com",
    );
    expect(result).toEqual(["alice@example.com"]);
  });
});
