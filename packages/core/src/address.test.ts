import { describe, expect, it } from "vitest";
import { checkEndpointUrl, isAddressAllowed, parseMode } from "./address.js";

describe("parseMode", () => {
  it("defaults to hosted and accepts only hosted or local", () => {
    expect(parseMode(undefined)).toBe("hosted");
    expect(parseMode("")).toBe("hosted");
    expect(parseMode("local")).toBe("local");
    expect(parseMode("hosted")).toBe("hosted");
    expect(() => parseMode("LOCAL")).toThrow(/MURPHY_MODE/);
  });
});

describe("isAddressAllowed", () => {
  it("keeps metadata blocked in local mode", () => {
    expect(isAddressAllowed("169.254.169.254", "local")).toBe(false);
    expect(isAddressAllowed("fd00:ec2::254", "local")).toBe(false);
    expect(isAddressAllowed("127.0.0.1", "local")).toBe(true);
    expect(isAddressAllowed("127.0.0.1", "hosted")).toBe(false);
  });
});

describe("checkEndpointUrl (hosted)", () => {
  it.each([
    ["http://hooks.example.com/x", "scheme_not_allowed"],
    ["ftp://example.com/x", "scheme_not_allowed"],
    ["not a url", "invalid_url"],
    ["https://user:pass@hooks.example.com/x", "credentials_in_url"],
    ["https://good.com@127.0.0.1/", "credentials_in_url"],
    ["https://127.0.0.1/x", "address_blocked"],
    ["https://10.1.2.3/x", "address_blocked"],
    ["https://192.168.1.10:8443/x", "address_blocked"],
    ["https://172.16.0.1/x", "address_blocked"],
    ["https://169.254.169.254/latest/meta-data/", "address_blocked"],
    ["https://2852039166/", "address_blocked"], // 169.254.169.254, decimal
    ["https://0x7f000001/", "address_blocked"], // 127.0.0.1, hex
    ["https://0177.0.0.1/", "address_blocked"], // 127.0.0.1, octal
    ["https://[::1]/", "address_blocked"],
    ["https://[::ffff:127.0.0.1]/", "address_blocked"],
    ["https://[fd00:ec2::254]/", "address_blocked"],
    ["https://[fe80::1]/", "address_blocked"],
    ["https://0.0.0.0/", "address_blocked"],
    ["https://100.64.0.1/", "address_blocked"],
    ["https://localhost/x", "address_blocked"],
    ["https://app.localhost/x", "address_blocked"],
  ])("rejects %s (%s)", (url, problem) => {
    const result = checkEndpointUrl(url, "hosted");
    expect(result).toMatchObject({ ok: false, problem });
    expect(result.ok || result.message.length).toBeGreaterThan(10);
  });

  it.each([
    "https://hooks.example.com/webhooks",
    "https://8.8.8.8/x",
    "https://[2606:4700:4700::1111]/x",
    "https://not-live-yet.invalid/webhooks", // never resolved here
    "https://internal.mycorp.example/x", // may resolve privately; delivery re-checks
  ])("accepts %s", (url) => {
    expect(checkEndpointUrl(url, "hosted")).toEqual({ ok: true });
  });
});

describe("checkEndpointUrl (local)", () => {
  it.each([
    "http://127.0.0.1:4242/webhooks",
    "http://localhost:3000/hooks",
    "http://192.168.1.20/x",
    "https://hooks.example.com/x",
    "http://user:pass@example.com/x", // local keeps its phase 1 rules: http(s) only
  ])("accepts %s", (url) => {
    expect(checkEndpointUrl(url, "local")).toEqual({ ok: true });
  });

  it("still requires http or https", () => {
    expect(checkEndpointUrl("ftp://example.com/", "local")).toMatchObject({
      ok: false,
      problem: "scheme_not_allowed",
    });
  });
});
