import { lookup as dnsLookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";

/**
 * hosted: https only, public unicast addresses only.
 * local:  http or https, also loopback and private LAN; cloud metadata stays blocked.
 */
export type MurphyMode = "hosted" | "local";

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

// Cloud metadata endpoints: blocked in every mode. 169.254.0.0/16 (incl. 169.254.169.254) is
// link-local and blocked by range; these are the ones that sit inside otherwise-allowed ranges.
const ALWAYS_BLOCKED = [ipaddr.parse("fd00:ec2::254")];

// ipaddr.js range names allowed per mode. Everything else (loopback, private, link-local,
// CGNAT, unspecified, broadcast, multicast, reserved, NAT64, 6to4, Teredo, ...) is blocked.
const ALLOWED_RANGES: Record<MurphyMode, ReadonlySet<string>> = {
  hosted: new Set(["unicast"]),
  local: new Set(["unicast", "loopback", "private", "uniqueLocal"]),
};

/** Classifies one IP address. IPv4-mapped IPv6 addresses are unwrapped and checked as IPv4. */
export function isAddressAllowed(address: string, mode: MurphyMode): boolean {
  if (!ipaddr.isValid(address)) return false;
  let ip = ipaddr.parse(address);
  if (ip.kind() === "ipv6" && (ip as ipaddr.IPv6).isIPv4MappedAddress()) {
    ip = (ip as ipaddr.IPv6).toIPv4Address();
  }
  if (
    ALWAYS_BLOCKED.some(
      (blocked) => blocked.kind() === ip.kind() && blocked.toString() === ip.toString(),
    )
  ) {
    return false;
  }
  return ALLOWED_RANGES[mode].has(ip.range());
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
  return { url, pinned: addresses[0]! };
}
