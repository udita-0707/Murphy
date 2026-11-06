# ADR 014: GitHub login, with a session cookie the browser cannot read

- Status: Accepted
- Date: 2026-11-07

## Context

The brief wants GitHub login next to API key login, with an httpOnly cookie, CSRF protection and a state parameter, mapping a user to
a project. It has to stay small, keep tenant isolation unchanged, and put no secret in the browser.

## Decision

**The dashboard's server runs the OAuth flow.** It holds the client secret. `state` and a PKCE verifier live in a ten-minute httpOnly cookie.
The callback compares `state` in constant time, exchanges the code on the server, and reads the numeric GitHub id. The scope is `read:user`.
**The GitHub token is then discarded, and never stored.**

**The API maps the user and creates the session.** `POST /internal/github-login` takes a shared secret (`MURPHY_INTERNAL_SECRET`). Without it the route
answers 404, and with no secret configured it is not mounted. It uses the existing `projects.owner_user_id`, as `github:<id>`, with a partial unique
index, so a first login racing itself still makes one project. No users table.

**A session is a token `ms_...`**, stored only as a SHA-256 hash, for 12 hours, revocable. `authenticate` accepts it next to `mk_...`, and sets the
same `projectId`, so every route below is unchanged.

**The browser holds an httpOnly cookie** (`__Host-murphy_session` on https; no prefix on plain http at localhost, because the prefix requires Secure).
SameSite=Lax. The proxy turns it into a bearer token and the cookie goes no further.

**CSRF.** A cookie is sent automatically, so any change made with one needs a matching `Origin` and a double-submit token in `x-murphy-csrf`. A bearer
token cannot be sent by another site, so API key requests need neither. The origin comes from `DASHBOARD_URL`, never from a request header.

**Hosted is closed by default.** `GITHUB_ALLOWED_LOGINS` lists who may sign in, and hosted mode refuses everyone when it is empty, because open sign-up
would let strangers send webhooks from this deployment. Local mode allows anyone when it is empty.

**Mock GitHub hosts** (`GITHUB_WEB_URL`, `GITHUB_API_URL`) are ignored outside local mode.

## Consequences

- API key login keeps working, and is unaffected by the cookie rules.
- A session cannot be used from the browser's scripts, so an XSS cannot steal it. It could still act as the user while the page is open, so the CSP stays strict.
- Failure messages on the sign-in page come from a fixed list. Nothing from the request is reflected.
- PKCE is sent, but GitHub's support for it is not confirmed by official documentation. `state` remains the required protection either way.

## What Udita sets up

A GitHub OAuth App. The callback is `<DASHBOARD_URL>/auth/github/callback`, for `http://127.0.0.1:3100` and for the hosted URL. GitHub's August 2026 changelog
allows up to 10 callback URLs on one OAuth App. If the settings page does not offer that, make two apps; only environment values change.
