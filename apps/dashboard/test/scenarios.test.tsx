import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as compare } from "@/app/api/compare/route";
import { POST as runs } from "@/app/api/runs/route";
import { ScenarioList } from "@/components/scenario-list";
import { compareUrl, cooperationNote, orderScenarios, type ScenarioRow } from "@/lib/scenarios";
import { setApiKey } from "@/lib/session";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const UUID = "6e0f0c1c-1111-4222-8333-444455556666";
const row = (over: Partial<ScenarioRow> = {}): ScenarioRow => ({
  id: UUID,
  slug: "x",
  name: "X",
  difficulty: "beginner",
  builtin: true,
  summary: {
    provider: "booking",
    provider_label: "Booking platform style",
    description: null,
    steps: 2,
    faults: [{ step: "a", kind: "duplicate", realised_by: "engine" }],
    needs_target_cooperation: false,
  },
  ...over,
});

beforeEach(() => {
  setApiKey("mk_test");
  push.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("scenario helpers", () => {
  it("puts the demo picks first, then built-ins, then the project's", () => {
    const ordered = orderScenarios([
      row({ slug: "mine", name: "A", builtin: false }),
      row({ slug: "other", name: "B" }),
      row({ slug: "booking-cancel-before-confirm", name: "C" }),
      row({ slug: "booking-duplicate-confirmation", name: "D" }),
    ]);
    expect(ordered.map((r) => r.slug)).toEqual([
      "booking-duplicate-confirmation",
      "booking-cancel-before-confirm",
      "other",
      "mine",
    ]);
  });

  it("says which scenarios need the target to cooperate", () => {
    expect(cooperationNote(row())).toBe("No target cooperation needed.");
    const target = row();
    target.summary!.faults = [{ step: "a", kind: "respond_with", realised_by: "target" }];
    expect(cooperationNote(target)).toContain("obey the signed block");
    expect(cooperationNote(row({ summary: null }))).toContain("Could not read");
  });

  it("carries both run ids in the URL, and a reason for a side that did not start", () => {
    expect(
      compareUrl({
        naive: { outcome: "started", runId: "a", seed: 1 },
        idempotent: { outcome: "started", runId: "b", seed: 1 },
      }),
    ).toBe("/compare?naive=a&idempotent=b");
    expect(
      compareUrl({
        naive: { outcome: "started", runId: "a", seed: 1 },
        idempotent: { outcome: "did_not_start", reason: "too busy" },
      }),
    ).toBe("/compare?naive=a&idempotent_error=too+busy");
  });
});

describe("ScenarioList", () => {
  const scenariosApi = (rows: ScenarioRow[], onPost?: () => Response) => {
    const posts: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (init.method === "POST") {
        posts.push(`${url} ${init.body as string}`);
        return onPost ? onPost() : Response.json({});
      }
      return Response.json({ data: rows });
    });
    return posts;
  };

  it("shows provider, difficulty, faults and cooperation", async () => {
    scenariosApi([row({ name: "Double booking" })]);
    render(<ScenarioList />);
    const item = (await screen.findByText("Double booking")).closest("li")!;
    expect(within(item).getByText(/Booking platform style/)).toBeTruthy();
    expect(within(item).getByText(/beginner/)).toBeTruthy();
    expect(within(item).getByText("Engine: duplicate")).toBeTruthy();
    expect(within(item).getByText("No target cooperation needed.")).toBeTruthy();
  });

  it("Run on both handlers goes to the comparison", async () => {
    const posts = scenariosApi([row()], () =>
      Response.json({
        naive: { outcome: "started", runId: "a", seed: 1 },
        idempotent: { outcome: "started", runId: "b", seed: 1 },
      }),
    );
    render(<ScenarioList />);
    fireEvent.click(await screen.findByRole("button", { name: "Run on both handlers" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/compare?naive=a&idempotent=b"));
    expect(posts[0]).toContain("/api/compare");
    expect(posts[0]).toContain(UUID);
  });

  it("one handler goes to its run", async () => {
    scenariosApi([row()], () => Response.json({ id: "r1" }));
    render(<ScenarioList />);
    fireEvent.click(await screen.findByRole("button", { name: "Run on idempotent only" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/runs/r1"));
  });

  it("shows why a run did not start, and lets you try again", async () => {
    scenariosApi([row()], () =>
      Response.json({ error: { message: "cannot reach the demo target" } }, { status: 502 }),
    );
    render(<ScenarioList />);
    fireEvent.click(await screen.findByRole("button", { name: "Run on both handlers" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "cannot reach the demo target",
    );
    expect(
      (screen.getByRole("button", { name: "Run on both handlers" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("has an empty state and an error state", async () => {
    scenariosApi([]);
    render(<ScenarioList />);
    expect(await screen.findByText("Nothing to break. Suspicious.")).toBeTruthy();
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
    render(<ScenarioList />);
    expect(await screen.findByText("The scenarios did not load.")).toBeTruthy();
  });
});

describe("the run-starting routes", () => {
  const post = (body: unknown, auth = true) =>
    new Request("http://dash/api/x", {
      method: "POST",
      headers: auth ? { authorization: "Bearer mk_x" } : {},
      body: JSON.stringify(body),
    });

  it("refuse without a credential, or with a bad body, before calling anything", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await compare(post({ scenario_id: UUID }, false))).status).toBe(401);
    expect((await compare(post({ scenario_id: "nope" }))).status).toBe(400);
    expect((await compare(post({ scenario_id: UUID, seed: -1 }))).status).toBe(400);
    expect((await runs(post({ scenario_id: UUID, handler: "evil" }))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("use the caller's token, and never send the target's admin token to the API", async () => {
    vi.stubEnv("DEMO_TARGET_ADMIN_TOKEN", "admin");
    vi.stubEnv("MURPHY_API_URL", "http://api");
    vi.stubEnv("MURPHY_TARGET_URL", "http://target");
    const seen: { url: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get("authorization") });
      if (url.endsWith("/_secrets")) return new Response(null, { status: 204 });
      if (url.endsWith("/v1/endpoints")) return Response.json({ id: "e1", secret: "whsec_x" });
      return Response.json({ id: "r1", seed: 1 }, { status: 202 });
    });
    const res = await runs(post({ scenario_id: UUID, handler: "naive" }));
    expect(res.status).toBe(202);
    for (const call of seen) {
      expect(call.auth).toBe(call.url.startsWith("http://target") ? "Bearer admin" : "Bearer mk_x");
    }
  });

  it("report a target that is down without leaking a stack", async () => {
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (url.endsWith("/_secrets")) throw new Error("refused");
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ id: "e1", secret: "whsec_x" });
    });
    const res = await runs(post({ scenario_id: UUID, handler: "naive" }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("target_unreachable");
    expect(JSON.stringify(body)).not.toContain("refused");
  });
});
