# ADR 005: SSRF protection for outbound deliveries

- Status: Accepted
- Date: 2026-10-26

## Context

Murphy sends HTTP requests to URLs chosen by its users. Without checks, a tenant could point
an endpoint at `http://169.254.169.254/` (cloud metadata and credentials), at `localhost`
admin ports, or at the hosting provider's private network, and read the response snippet in
the delivery log. DNS makes this harder than checking the URL text: a hostname can resolve to
a private address, resolve to several addresses, or change between the check and the
connection (DNS rebinding). Attackers also use odd address spellings such as
`http://2130706433/`, `http://0x7f000001/`, `http://0177.0.0.1/`, `http://[::ffff:7f00:1]/` or
`http://good.com@127.0.0.1/`.

Developers testing locally still need to deliver to `http://localhost:3000`.

## Decision

`safeTarget(url, mode)` in `apps/worker/src/net/ssrf.ts` runs before every delivery attempt
(address classification lives in `packages/core/src/address.ts`),
and `sendWebhook` in `send.ts` sends the request.

**Modes.** `MURPHY_MODE` is `hosted` (the default when unset) or `local`.

- `hosted`: `https` only; only public unicast addresses.
- `local`: `http` or `https`; public addresses plus loopback, RFC 1918 private ranges and IPv6
  unique-local addresses. Cloud metadata addresses stay blocked.

**Parsing.** The URL is parsed with the WHATWG `URL` parser, which normalises decimal, hex,
octal and short IPv4 forms and IPv6 literals to their canonical form. The checks run on the
parsed host, which is exactly what the connection uses. URLs with userinfo
(`user:pass@` or `good.com@`) are rejected outright.

**Resolution.** IP literals are checked directly. Hostnames are resolved for all A and AAAA
records, and the target is rejected if ANY record is blocked. A mixed public and private
answer is rejected, not filtered.

**Classification** uses ipaddr.js range names. IPv4-mapped IPv6 addresses (`::ffff:0:0/96`)
are unwrapped and checked as IPv4. Everything that is not allowed for the mode is blocked,
which covers: loopback, RFC 1918, `169.254.0.0/16` link-local (including metadata),
`100.64.0.0/10` CGNAT, `0.0.0.0/8`, multicast, broadcast, reserved and documentation ranges,
`::1`, `::`, `fc00::/7` (hosted), `fe80::/10`, `64:ff9b::/96` NAT64, 6to4 and Teredo.
`fd00:ec2::254` (the AWS IPv6 metadata address) is blocked in every mode even though it sits
in `fc00::/7`.

**Pinning.** The connection goes through an undici `Agent` whose `connect.lookup` always
returns the validated address, so a second DNS answer cannot redirect the connection. The
`Host` header and TLS SNI keep the original hostname, so certificates still validate. Which
validated address is pinned: in `local` mode the first IPv4 address if there is one (so
`localhost`, which often resolves to `::1` first, reaches a receiver listening only on
127.0.0.1); in `hosted` mode the resolver's first answer. The choice is made only among
addresses that all passed the checks, so it never widens what is allowed (decided
2026-10-26).

**Request limits.** Redirects are never followed; a 3xx is returned as a status and treated
as a failed attempt. One total timeout (10 s) covers connecting, headers and body. At most
1 KB of the response body is read, then the stream is cancelled.

## Consequences

- Validation happens at delivery time, not only when the endpoint is created, so a hostname
  that later starts resolving to a private address is still blocked. A blocked attempt is
  logged as `ssrf_blocked` with the reason.
- Local development needs `MURPHY_MODE=local` (commented out in `.env.example`). A deployment that forgets
  the variable gets the safe `hosted` behaviour.
- Receivers behind a redirect (for example http to https) must register the final URL.
- Pinning uses one validated address (IPv4 first in local mode), so there is no fallback to a
  second address if it is unreachable. That is acceptable for webhooks, which are retried.
- **Create-time check (decided 2026-10-26).** In hosted mode the API also rejects, when an
  endpoint is created or its URL is patched, a non-https scheme, userinfo, a literal private,
  loopback, link-local or metadata IP (in any spelling), and `localhost`/`*.localhost`, with
  `400 endpoint_url_not_allowed`. It does not resolve DNS, so an endpoint whose DNS is not
  live yet can still be registered; the delivery-time check stays the final authority. Local
  mode keeps the phase 1 rule (http or https). The address rules live in `@murphy/core`
  (`isAddressAllowed`, `checkEndpointUrl`), shared by the API and the worker.

## Alternatives considered

- **Check the URL text with a regex or blocklist:** bypassed by odd IP spellings and DNS.
- **Resolve, check, then let the HTTP client resolve again:** vulnerable to DNS rebinding.
- **Connect to the IP and set the Host header manually:** breaks TLS SNI and certificate
  validation for https endpoints.
- **An egress proxy (e.g. smokescreen):** strongest isolation, but one more service to run
  for a hackathon deployment. Worth revisiting for a production deployment.
