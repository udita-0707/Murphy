import { describe, expect, it, vi } from "vitest";
import { isAddressAllowed, type Resolver, safeTarget, SsrfError } from "../src/net/ssrf.js";

const BLOCKED_EVERYWHERE = [
  // IPv4
  "169.254.169.254", // cloud metadata
  "169.254.1.1", // link-local
  "100.64.0.1", // CGNAT
  "100.127.255.254",
  "0.0.0.0",
  "0.1.2.3",
  "224.0.0.1", // multicast
  "239.255.255.250",
  "255.255.255.255", // broadcast
  "240.0.0.1", // reserved
  "192.0.2.10", // TEST-NET-1
  "198.18.0.1", // benchmarking
  // IPv6
  "::", // unspecified
  "fe80::1", // link-local
  "ff02::1", // multicast
  "64:ff9b::7f00:1", // NAT64 wrapping 127.0.0.1
  "64:ff9b::a9fe:a9fe", // NAT64 wrapping metadata
  "2002:7f00:1::", // 6to4 wrapping 127.0.0.1
  "2001:db8::1", // documentation
  "fd00:ec2::254", // AWS IPv6 metadata
  "::ffff:169.254.169.254", // IPv4-mapped metadata
  "::ffff:a9fe:a9fe",
  "::ffff:100.64.0.1",
];

const PRIVATE_LAN = [
  "127.0.0.1",
  "127.255.255.254",
  "10.0.0.1",
  "172.16.0.1",
  "172.31.255.255",
  "192.168.1.10",
  "::1",
  "fd12:3456::1", // unique local
  "fc00::1",
  "::ffff:127.0.0.1", // IPv4-mapped loopback
  "::ffff:7f00:1",
  "::ffff:10.0.0.1",
];

const PUBLIC = ["8.8.8.8", "93.184.215.14", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"];

describe("isAddressAllowed", () => {
  it.each(BLOCKED_EVERYWHERE)("blocks %s in hosted and local mode", (ip) => {
    expect(isAddressAllowed(ip, "hosted")).toBe(false);
    expect(isAddressAllowed(ip, "local")).toBe(false);
  });

  it.each(PRIVATE_LAN)("blocks %s in hosted mode but allows it in local mode", (ip) => {
    expect(isAddressAllowed(ip, "hosted")).toBe(false);
    expect(isAddressAllowed(ip, "local")).toBe(true);
  });

  it.each(PUBLIC)("allows public %s in both modes", (ip) => {
    expect(isAddressAllowed(ip, "hosted")).toBe(true);
    expect(isAddressAllowed(ip, "local")).toBe(true);
  });

  it("rejects strings that are not IP addresses", () => {
    expect(isAddressAllowed("example.com", "local")).toBe(false);
    expect(isAddressAllowed("", "local")).toBe(false);
  });
});

const publicResolver: Resolver = async () => [{ address: "93.184.215.14", family: 4 }];

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof SsrfError) return err.reason;
    throw err;
  }
  return "allowed";
}

describe("safeTarget", () => {
  it.each([
    "https://127.0.0.1/",
    "https://2130706433/", // decimal
    "https://0x7f000001/", // hex
    "https://0177.0.0.1/", // octal
    "https://0x7f.1/", // mixed short form
    "https://127.1/",
    "https://[::ffff:127.0.0.1]/", // IPv4-mapped IPv6
    "https://[::ffff:7f00:1]/",
    "https://[::1]/",
    "https://0/",
    "https://[::]/",
    "https://169.254.169.254/latest/meta-data/",
    "https://2852039166/", // 169.254.169.254 as decimal
    "https://0xa9fea9fe/", // 169.254.169.254 as hex
    "https://0251.0376.0251.0376/", // 169.254.169.254 as octal
    "https://[::ffff:a9fe:a9fe]/",
    "https://[fd00:ec2::254]/",
  ])("blocks %s in hosted mode without resolving DNS", async (url) => {
    const resolver = vi.fn(publicResolver);
    expect(await reason(safeTarget(url, "hosted", resolver))).toBe("address_blocked");
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each([
    "http://2852039166/",
    "http://0xa9fea9fe/",
    "http://0251.0376.0251.0376/",
    "http://[::ffff:169.254.169.254]/",
    "http://[fd00:ec2::254]/",
  ])("still blocks metadata form %s in local mode", async (url) => {
    expect(await reason(safeTarget(url, "local", publicResolver))).toBe("address_blocked");
  });

  it.each([
    "http://2130706433:3000/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://[::ffff:7f00:1]/",
  ])("allows loopback form %s in local mode", async (url) => {
    const target = await safeTarget(url, "local", publicResolver);
    expect(["127.0.0.1", "::ffff:7f00:1"]).toContain(target.pinned.address);
  });

  it.each([
    "https://good.com@127.0.0.1/",
    "https://good.com@evil.example/",
    "https://user:pass@example.com/",
    "http://good.com@127.0.0.1/",
  ])("rejects userinfo tricks like %s", async (url) => {
    for (const mode of ["hosted", "local"] as const) {
      const result = await reason(safeTarget(url, mode, publicResolver));
      // In hosted mode http:// fails the scheme check first; either way it never connects.
      expect(["credentials_in_url", "scheme_not_allowed"]).toContain(result);
      expect(result).not.toBe("allowed");
    }
  });

  it("enforces scheme rules per mode", async () => {
    expect(await reason(safeTarget("http://example.com/", "hosted", publicResolver))).toBe(
      "scheme_not_allowed",
    );
    expect(await reason(safeTarget("https://example.com/", "hosted", publicResolver))).toBe(
      "allowed",
    );
    expect(await reason(safeTarget("http://example.com/", "local", publicResolver))).toBe(
      "allowed",
    );
    for (const url of ["ftp://example.com/", "file:///etc/passwd", "gopher://example.com/"]) {
      expect(await reason(safeTarget(url, "local", publicResolver))).toBe("scheme_not_allowed");
    }
    expect(await reason(safeTarget("not a url", "local", publicResolver))).toBe("invalid_url");
  });

  it("rejects a hostname if ANY of its addresses is blocked", async () => {
    const mixed: Resolver = async () => [
      { address: "93.184.215.14", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ];
    expect(await reason(safeTarget("https://mixed.example/", "hosted", mixed))).toBe(
      "address_blocked",
    );
    const mixedV6: Resolver = async () => [
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "::ffff:169.254.169.254", family: 6 },
    ];
    expect(await reason(safeTarget("https://mixed6.example/", "local", mixedV6))).toBe(
      "address_blocked",
    );
  });

  it("pins the first validated address and resolves only once", async () => {
    const resolver = vi.fn<Resolver>(async () => [
      { address: "93.184.215.14", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
    const target = await safeTarget("https://hooks.example.com/x", "hosted", resolver);
    expect(target.pinned).toEqual({ address: "93.184.215.14", family: 4 });
    expect(target.url.hostname).toBe("hooks.example.com");
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith("hooks.example.com");
  });

  it("reports DNS failures and empty answers", async () => {
    const failing: Resolver = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await reason(safeTarget("https://nope.example/", "hosted", failing))).toBe("dns_failed");
    expect(await reason(safeTarget("https://empty.example/", "hosted", async () => []))).toBe(
      "no_addresses",
    );
  });
});
