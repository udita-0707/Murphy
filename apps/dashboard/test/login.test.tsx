import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginForm, signInError } from "@/components/login-form";
import { contentSecurityPolicy } from "@/middleware";
import { getApiKey, setApiKey } from "@/lib/session";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

beforeEach(() => {
  setApiKey(null);
  push.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

const signIn = (key: string) => {
  render(<LoginForm />);
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: key } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
};

describe("LoginForm", () => {
  it("checks the key against the API, keeps it in this tab, and moves on", async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    signIn("  mk_good ");
    await waitFor(() => expect(push).toHaveBeenCalledWith("/scenarios"));
    expect(window.sessionStorage.getItem("murphy.apiKey")).toBe("mk_good");
    expect(window.localStorage.getItem("murphy.apiKey")).toBeNull();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/scenarios");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer mk_good");
  });

  it("refuses a bad key, and stores nothing", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 401 }));
    signIn("mk_bad");
    expect((await screen.findByRole("alert")).textContent).toContain("That key was refused");
    expect(getApiKey()).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it("does not call the API with an empty key", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    signIn("   ");
    expect((await screen.findByRole("alert")).textContent).toContain("Paste your API key");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says when the API is down", () => {
    expect(signInError(502)).toContain("cannot be reached");
  });
});

describe("content security policy", () => {
  it("allows only this origin's scripts in production, and no framing", () => {
    const policy = contentSecurityPolicy("abc", false);
    expect(policy).toContain("script-src 'self' 'nonce-abc'");
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("connect-src 'self'");
  });
});
