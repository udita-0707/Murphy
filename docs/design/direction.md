# Murphy dashboard: design direction

Second direction, chosen by Udita on 2026-11-07 after seeing the first: **cheerful, tactile, with buttons that press like keys.** She found the first one had too many
boxes and borders, was too big and blocky, and had plain, lifeless colours. Hallmark owns this direction. The Taste skill was dropped for this phase.

**Theme:** Squeeze, dealt 1 of 3 for the playful genre: soft rounded tiles, round heavy Gabarito over Manrope, a whole page of real colour, peach controls. Cream is the
light backup for a bright room, and uses the same token names.

## Waivers on record

- **The ground is blue, not Squeeze's forest green.** On a tool whose verdicts are PASS and FAIL, a green page reads as "all good", and red on green is hard for colour-blind viewers.
- **Keycaps come from the Cobalt theme.** A key has a face and a bottom edge. It lifts 1px on hover and sinks on press. Udita asked for this.
- **Two added colours.** Tomato and mint are for verdict marks only.
- **Mono for code only.** Squeeze allows no mono, but a JSON payload needs it. It uses the system's mono face.

## Verdicts

Each one must read correctly in greyscale. The word is always present.

| Verdict | Shape                                                 | Wording                                                     |
| ------- | ----------------------------------------------------- | ----------------------------------------------------------- |
| FAIL    | Solid filled plate with a drawn cross                 | `FAIL`, then the report's reason                            |
| PASS    | Hollow plate with a ring and a drawn check            | `PASS`, then "Survived these faults, in this run"           |
| errored | Dashed outline with hazard stripes, no cross or check | `ERRORED`, then "Not a fair test, proves nothing", then why |

## Surfaces, type, motion

- Tiles, not boxes: a tile is the ground one step lighter, with no border. The warm-white card is the one raised surface, on sign-in.
- Gabarito 800 for heads and figures, Manrope 500 and 700 for the rest. Self-hosted, so that exports can embed them.
- Sizes: labels 15px, body 16, timeline rows 17, heads 24, verdict word 64, diverging figures 88. A large projector resolution scales the whole set by 125%.
- Motion is state: keys press, rows flash once, a verdict lands once. Nothing loops. Reduced motion removes it.

## Voice

Humour lives only in empty, loading and login states. Reports, evidence and verdicts stay deadpan, because a joke beside evidence weakens the evidence.

## Signature

The shared row spine of the split screen, ending in the diverging figure, such as "Booking effect 2 vs 1". The figure comes from the two reports and is never hardcoded.

## Approved decisions from the plan

1. The public URL does everything except the chaos panel, which stays local only and says so.
2. Hosted GitHub login uses an allowlist, `GITHUB_ALLOWED_LOGINS`.
3. Hosting on Railway still needs its own go-ahead, before any deployment.
4. `puppeteer-core` is a root dev dependency, using the installed Chrome.
5. Redis is cut (ADR 016).
