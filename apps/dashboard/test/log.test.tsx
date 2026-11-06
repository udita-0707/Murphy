import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DeliveriesView,
  DeliveryView,
  DlqView,
  EndpointsView,
  EventsView,
  EventView,
} from "@/components/log-views";
import {
  canReplay,
  formatTime,
  isSimulatedEndpoint,
  lastResult,
  withSimulatedFilter,
  type DeliveryRow,
  type EndpointRow,
  type EventRow,
} from "@/lib/log";
import { setApiKey } from "@/lib/session";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/deliveries",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

const delivery = (over: Partial<DeliveryRow> = {}): DeliveryRow => ({
  id: "d1",
  event_id: "e1",
  endpoint_id: "ep1",
  status: "dead",
  attempt_count: 9,
  next_attempt_at: "2026-11-07T00:00:00.000Z",
  last_status_code: 500,
  last_error: null,
  created_at: "2026-11-07T00:00:00.000Z",
  completed_at: null,
  event_type: "order.paid",
  simulated: false,
  ...over,
});
const event = (over: Partial<EventRow> = {}): EventRow => ({
  id: "e1",
  type: "order.paid",
  idempotency_key: "k",
  created_at: "2026-11-07T00:00:00.000Z",
  simulated: false,
  scenario_run_id: null,
  deliveries: 1,
  ...over,
});
const endpoint = (over: Partial<EndpointRow> = {}): EndpointRow => ({
  id: "ep1",
  url: "https://example.test/hook",
  description: null,
  event_filter: [],
  status: "active",
  created_at: "2026-11-07T00:00:00.000Z",
  ...over,
});

/** Answers by URL, and records every request. */
function api(routes: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET" });
    return routes(url, init);
  });
  return calls;
}
const page = (data: unknown[], next: string | null = null) =>
  Response.json({ data, next_cursor: next });

beforeEach(() => {
  setApiKey("mk_test");
  replace.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("helpers", () => {
  it("adds the filter to a path, only when hiding", () => {
    expect(withSimulatedFilter("/x", false)).toBe("/x");
    expect(withSimulatedFilter("/x", true)).toBe("/x?simulated=false");
    expect(withSimulatedFilter("/x?a=1", true)).toBe("/x?a=1&simulated=false");
  });
  it("knows which statuses can be replayed", () => {
    for (const s of ["succeeded", "failed", "dead"]) expect(canReplay(s)).toBe(true);
    for (const s of ["pending", "in_flight", "cancelled"]) expect(canReplay(s)).toBe(false);
  });
  it("marks run endpoints as simulated", () => {
    expect(isSimulatedEndpoint(endpoint({ event_filter: ["__murphy_simulation__"] }))).toBe(true);
    expect(isSimulatedEndpoint(endpoint())).toBe(false);
  });
  it("shows the last result, or the error when there was no reply", () => {
    expect(lastResult({ last_status_code: 500, last_error: "x" })).toBe("500");
    expect(lastResult({ last_status_code: null, last_error: "timeout" })).toBe("timeout");
  });
  it("formats a time, and leaves nothing for no time", () => {
    expect(formatTime("2026-11-07T01:02:03.000Z")).toBe("2026-11-07 01:02:03");
    expect(formatTime(null)).toBe("");
  });
});

describe("endpoints", () => {
  const rows = [
    endpoint({ url: "https://real.test/a", status: "paused" }),
    endpoint({
      id: "ep2",
      url: "http://127.0.0.1:4343/naive",
      event_filter: ["__murphy_simulation__"],
      description: "murphy run: naive",
    }),
  ];

  it("lists status, and marks simulated ones", async () => {
    api(() => page(rows));
    render(<EndpointsView hide={false} />);
    expect(await screen.findByText("https://real.test/a")).toBeTruthy();
    expect(screen.getByText("paused")).toBeTruthy();
    expect(screen.getByText("simulated")).toBeTruthy();
  });

  it("hides simulated ones when asked", async () => {
    api(() => page(rows));
    render(<EndpointsView hide />);
    expect(await screen.findByText("https://real.test/a")).toBeTruthy();
    expect(screen.queryByText("http://127.0.0.1:4343/naive")).toBeNull();
  });

  it("has an empty state", async () => {
    api(() => page([]));
    render(<EndpointsView hide={false} />);
    expect(await screen.findByText("No endpoints. Nothing can fail. Yet.")).toBeTruthy();
  });
});

describe("the simulated filter", () => {
  it("asks the API to leave simulated traffic out", async () => {
    const calls = api(() => page([]));
    render(<EventsView hide />);
    await screen.findByText("Nothing has failed yet. Give it a minute.");
    expect(calls[0]?.url).toBe("/api/v1/events?simulated=false");
  });

  it("the checkbox writes it to the URL", async () => {
    api(() => page([delivery()]));
    render(<DeliveriesView hide={false} />);
    fireEvent.click(await screen.findByLabelText("Hide simulated traffic"));
    expect(replace).toHaveBeenCalledWith("/deliveries?hide_simulated=1");
  });
});

describe("events", () => {
  it("links each to its detail, and pages with Load more", async () => {
    const calls = api((url) =>
      url.includes("cursor=")
        ? page([event({ id: "e2", type: "second" })])
        : page([event()], "abc"),
    );
    render(<EventsView hide={false} />);
    const link = await screen.findByRole("link", { name: "order.paid" });
    expect(link.getAttribute("href")).toBe("/events/e1");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("second")).toBeTruthy();
    expect(screen.getByText("order.paid")).toBeTruthy();
    expect(calls[1]?.url).toBe("/api/v1/events?cursor=abc");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("has an error state with a retry", async () => {
    let up = false;
    api(() => (up ? page([event()]) : new Response("{}", { status: 500 })));
    render(<EventsView hide={false} />);
    expect(await screen.findByText("The events did not load.")).toBeTruthy();
    up = true;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("order.paid")).toBeTruthy();
  });

  it("shows detail with payload and a link to its run", async () => {
    api(() =>
      Response.json({
        ...event({ simulated: true, scenario_run_id: "r1" }),
        payload: { a: 1 },
        deliveries: [delivery()],
      }),
    );
    render(<EventView id="e1" />);
    expect((await screen.findByLabelText("Event payload")).textContent).toContain('"a": 1');
    expect(screen.getByRole("link", { name: "r1" }).getAttribute("href")).toBe("/runs/r1");
  });
});

describe("delivery detail", () => {
  const detail = {
    ...delivery(),
    attempts: [
      {
        id: "a1",
        attempt_no: 1,
        started_at: "2026-11-07T00:00:00.000Z",
        duration_ms: 12,
        response_status: 500,
        response_body_snippet: "<b>boom</b>",
        error: null,
        request_headers: { "webhook-signature": "v1,secret-looking" },
      },
      {
        id: "a2",
        attempt_no: 2,
        started_at: "2026-11-07T00:00:05.000Z",
        duration_ms: null,
        response_status: null,
        response_body_snippet: null,
        error: "connect timeout",
      },
    ],
  };

  it("shows each attempt, escapes a response, and does not show request headers", async () => {
    api(() => Response.json(detail));
    const { container } = render(<DeliveryView id="d1" />);
    expect(await screen.findByText("<b>boom</b>")).toBeTruthy();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText("connect timeout")).toBeTruthy();
    expect(screen.getByText("no reply")).toBeTruthy();
    expect(container.textContent).not.toContain("secret-looking");
  });

  it("replays, and offers no replay for something in progress", async () => {
    const calls = api((_u, init) =>
      init.method === "POST" ? Response.json({}) : Response.json(detail),
    );
    const { unmount } = render(<DeliveryView id="d1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Replay" }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "POST" && c.url === "/api/v1/deliveries/d1/replay"),
      ).toBe(true),
    );
    unmount();
    api(() => Response.json({ ...detail, status: "in_flight" }));
    render(<DeliveryView id="d1" />);
    await screen.findByText("in flight");
    expect(screen.queryByRole("button", { name: "Replay" })).toBeNull();
  });

  it("says when a delivery is not in this project", async () => {
    api(() => Response.json({ error: { message: "delivery not found" } }, { status: 404 }));
    render(<DeliveryView id="d1" />);
    expect(await screen.findByText("No such delivery in your project.")).toBeTruthy();
  });
});

describe("the DLQ", () => {
  it("replays one row, and shows the API's refusal in that row", async () => {
    api((_u, init) =>
      init.method === "POST"
        ? Response.json(
            { error: { message: "the delivery's endpoint was deleted" } },
            { status: 409 },
          )
        : page([delivery()]),
    );
    render(<DlqView hide={false} />);
    const row = (await screen.findByRole("link", { name: "order.paid" })).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Replay" }));
    expect((await within(row).findByRole("alert")).textContent).toContain("endpoint was deleted");
  });

  it("replays all shown only after confirming, and only the rows shown", async () => {
    const rows = [delivery({ id: "a" }), delivery({ id: "b" })];
    const calls = api((_u, init) => (init.method === "POST" ? Response.json({}) : page(rows)));
    render(<DlqView hide />);
    fireEvent.click(await screen.findByRole("button", { name: "Replay all shown" }));
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Send 2 again" }));
    expect(await screen.findByText("2 queued.")).toBeTruthy();
    expect(
      calls
        .filter((c) => c.method === "POST")
        .map((c) => c.url)
        .sort(),
    ).toEqual(["/api/v1/deliveries/a/replay", "/api/v1/deliveries/b/replay"]);
    expect(calls[0]?.url).toBe("/api/v1/dlq?simulated=false");
  });

  it("can back out of replaying all", async () => {
    const calls = api(() => page([delivery()]));
    render(<DlqView hide={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "Replay all shown" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(screen.getByRole("button", { name: "Replay all shown" })).toBeTruthy();
  });

  it("says how many were refused", async () => {
    api((url, init) => {
      if (init.method !== "POST") return page([delivery({ id: "a" }), delivery({ id: "b" })]);
      return url.includes("/a/")
        ? Response.json({})
        : Response.json({ error: { message: "no" } }, { status: 409 });
    });
    render(<DlqView hide={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "Replay all shown" }));
    fireEvent.click(screen.getByRole("button", { name: "Send 2 again" }));
    expect(await screen.findByText(/1 queued\. 1 refused/)).toBeTruthy();
  });

  it("has its empty state", async () => {
    api(() => page([]));
    render(<DlqView hide={false} />);
    expect(await screen.findByText("Nothing dead. Suspicious.")).toBeTruthy();
  });
});
