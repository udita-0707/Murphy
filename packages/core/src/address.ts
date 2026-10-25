import ipaddr from "ipaddr.js";

/**
 * Delivery safety mode (ADR 005).
 * hosted: https only, public unicast addresses only. The default.
 * local:  http or https, also loopback and private LAN; cloud metadata stays blocked.
 */
export type MurphyMode = "hosted" | "local";

/** Parses MURPHY_MODE. Unset or empty means hosted, the safe choice. */
export function parseMode(raw: string | undefined): MurphyMode {
  if (raw === undefined || raw === "") return "hosted";
  if (raw === "hosted" || raw === "local") return raw;
  throw new Error(`MURPHY_MODE must be "hosted" or "local", got "${raw}"`);
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

export type EndpointUrlProblem =
  "invalid_url" | "scheme_not_allowed" | "credentials_in_url" | "address_blocked";

export type EndpointUrlCheck =
  { ok: true } | { ok: false; problem: EndpointUrlProblem; message: string };

/**
 * Fast, DNS-free check of an endpoint URL when it is created or changed, for early feedback
 * in hosted mode: https only, no userinfo, and no literal IP (in any spelling the URL parser
 * accepts) or `localhost` name that hosted delivery would refuse. Hostnames are not resolved,
 * so an endpoint whose DNS is not live yet can still be registered. The delivery-time SSRF
 * check stays the final authority. Local mode only requires http or https.
 */
export function checkEndpointUrl(raw: string, mode: MurphyMode): EndpointUrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, problem: "invalid_url", message: "url must be a valid http or https URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, problem: "scheme_not_allowed", message: "url must use http or https" };
  }
  if (mode === "local") return { ok: true };

  if (url.protocol !== "https:") {
    return {
      ok: false,
      problem: "scheme_not_allowed",
      message: "url must use https in hosted mode",
    };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      problem: "credentials_in_url",
      message: "url must not contain credentials (user:password@ or name@ before the host)",
    };
  }
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (ipaddr.isValid(host) && !isAddressAllowed(host, "hosted")) {
    return {
      ok: false,
      problem: "address_blocked",
      message: `url points to ${host}, a private, loopback, link-local or metadata address that cannot receive webhooks in hosted mode`,
    };
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    return {
      ok: false,
      problem: "address_blocked",
      message: `url points to ${host}, which always means this machine and cannot receive webhooks in hosted mode`,
    };
  }
  return { ok: true };
}
