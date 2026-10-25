import { lookup as dnsLookup } from "node:dns/promises";
import { isAddressAllowed, type MurphyMode } from "@murphy/core";
import ipaddr from "ipaddr.js";

export { isAddressAllowed, type MurphyMode } from "@murphy/core";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves every A and AAAA record for a hostname. Injectable for tests. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

export type SsrfReason =
  | "invalid_url"
  | "scheme_not_allowed"
  | "credentials_in_url"
  | "dns_failed"
  | "no_addresses"
  | "address_blocked";

export class SsrfError extends Error {
  constructor(
    readonly reason: SsrfReason,
    message: string,
  ) {
    super(message);
    this.name = "SsrfError";
  }
}

export interface SafeTarget {
  url: URL;
  /** The validated address every connection for this request must use. */
  pinned: ResolvedAddress;
}

/**
 * Validates an endpoint URL for delivery and picks the address to pin the connection to.
 * Rejects if the scheme is not allowed for the mode, the URL carries credentials, or ANY
 * resolved address is blocked (a mixed public/private answer is rejected, not filtered).
 */
export async function safeTarget(
  rawUrl: string,
  mode: MurphyMode,
  resolver: Resolver = systemResolver,
): Promise<SafeTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError("invalid_url", "endpoint URL is not a valid URL");
  }

  const schemes = mode === "hosted" ? ["https:"] : ["https:", "http:"];
  if (!schemes.includes(url.protocol)) {
    throw new SsrfError(
      "scheme_not_allowed",
      `scheme ${url.protocol} is not allowed in ${mode} mode`,
    );
  }
  if (url.username || url.password) {
    throw new SsrfError("credentials_in_url", "endpoint URLs must not contain credentials");
  }

  // WHATWG URL parsing has already normalised decimal/hex/octal IPv4 forms and IPv6 literals.
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  let addresses: ResolvedAddress[];
  if (ipaddr.isValid(host)) {
    addresses = [{ address: host, family: ipaddr.parse(host).kind() === "ipv6" ? 6 : 4 }];
  } else {
    try {
      addresses = await resolver(host);
    } catch (err) {
      throw new SsrfError("dns_failed", `could not resolve ${host}: ${(err as Error).message}`);
    }
  }
  if (addresses.length === 0) {
    throw new SsrfError("no_addresses", `${host} has no A or AAAA records`);
  }
  const blocked = addresses.find((a) => !isAddressAllowed(a.address, mode));
  if (blocked) {
    throw new SsrfError(
      "address_blocked",
      `${host} resolves to blocked address ${blocked.address}`,
    );
  }
  return { url, pinned: pickPinned(addresses, mode) };
}

/**
 * Chooses which validated address the connection is pinned to. Every address has already
 * passed the checks above, so this never widens what is allowed.
 *
 * In local mode IPv4 is preferred: `localhost` usually resolves to `::1` first, and a dev
 * receiver listening only on 127.0.0.1 would otherwise refuse the connection. Hosted mode
 * keeps the resolver's order.
 */
export function pickPinned(
  addresses: readonly ResolvedAddress[],
  mode: MurphyMode,
): ResolvedAddress {
  if (mode === "local") {
    const ipv4 = addresses.find((a) => a.family === 4);
    if (ipv4) return ipv4;
  }
  return addresses[0]!;
}
