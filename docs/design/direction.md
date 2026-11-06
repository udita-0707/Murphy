# Murphy dashboard: design direction

Approved by Udita on 2026-11-07. Hallmark owns this direction. The Taste skill was dropped for this phase, so polish follows
Hallmark's motion and craft rules.

**Idea: an incident departure board.** Webhooks are the trains, and Murphy announces which ones went wrong. A departure board is
built to be read from across a room, and this dashboard is shown on a projector.

**Theme:** Wayfind, dealt 1 of 3, in its `night` colourway. Its `platform` colourway is the light backup for a bright room, and
uses the same token names.

## Waivers on record

- **Two added colours.** Wayfind forbids a third bright colour. `fail` and `pass` are added, for verdict marks only, because the
  brief requires verdicts that are clearly distinct.
- **Control height.** Controls are 44 to 48px, above Hallmark's app range of 32 to 40px, for legibility on a projector.

## Verdicts

Each one must read correctly in greyscale. The word is always present.

| Verdict | Shape                                                 | Wording                                                     |
| ------- | ----------------------------------------------------- | ----------------------------------------------------------- |
| FAIL    | Solid filled plate with a drawn cross                 | `FAIL`, then the report's reason                            |
| PASS    | Hollow plate with a 2px outline and a drawn check     | `PASS`, then "Survived these faults, in this run"           |
| errored | Dashed outline with hazard stripes, no cross or check | `ERRORED`, then "Not a fair test, proves nothing", then why |

## Type, space, motion

- Chivo Mono throughout, at 400, 500 and 800, self-hosted so that exports can embed it.
- Fixed sizes: labels 16px (the smallest anywhere), body 18, timeline rows 20, heads 28, verdict word 96, diverging figures 120.
- Labels are sentence case and untracked. Only the three verdict words are capitals.
- 4px spacing base, a capped and centred container, radius 0, 2px borders, ink plates.
- Motion is state only: rows update in place, a new row flashes once, a verdict lands with one short step. Nothing loops. Reduced
  motion makes everything instant.

## Voice

Humour lives only in empty, loading and login states. Reports, evidence and verdicts stay deadpan, because a joke beside evidence
weakens the evidence.

## Signature

The shared row spine of the split screen, ending in the diverging figure, such as "Booking effect 2 vs 1". The figure comes from
the two reports and is never hardcoded.

## Approved decisions from the plan

1. Wayfind night, with the two verdict colours.
2. The public URL does everything except the chaos panel, which stays local only and says so.
3. Hosted GitHub login uses an allowlist, `GITHUB_ALLOWED_LOGINS`.
4. Hosting on Railway still needs its own go-ahead, before any deployment.
5. `puppeteer-core` is a root dev dependency, using the installed Chrome.
6. Redis is cut, recorded in an ADR, and removed after the demo path is safe.
