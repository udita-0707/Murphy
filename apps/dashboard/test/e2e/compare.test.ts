// @vitest-environment node
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT, startStack, type Stack } from "../../../../packages/cli/test/stack.js";

const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DIST = ".next-e2e";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

let stack: Stack;
let dashboard: ChildProcess;
let browser: Browser;
let page: Page;
let base: string;
const problems: string[] = [];

beforeAll(async () => {
  stack = await startStack();
  const cwd = path.join(REPO_ROOT, "apps/dashboard");
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NEXT_DIST_DIR: DIST,
    MURPHY_API_URL: stack.apiUrl,
    MURPHY_TARGET_URL: stack.targetUrl,
  };
  const built = spawnSync("pnpm", ["exec", "next", "build"], {
    cwd,
    encoding: "utf8",
    env: { ...env, NODE_ENV: "production" },
  });
  if (built.status !== 0) throw new Error(`next build failed: ${built.stdout}\n${built.stderr}`);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  dashboard = spawn("pnpm", ["exec", "next", "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd,
    env: { ...env, NODE_ENV: "production" },
    stdio: "ignore",
    detached: true,
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    const up = await fetch(base).then(
      (r) => r.ok,
      () => false,
    );
    if (up) break;
    if (Date.now() > deadline) throw new Error("the dashboard did not start");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  page.on("pageerror", (err) => problems.push(String(err)));
}, 300_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  if (dashboard?.pid) {
    try {
      process.kill(-dashboard.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await stack?.stop();
}, 60_000);

const verdictOf = (side: string) =>
  page.$eval(`[data-side="${side}"] [data-verdict]`, (el) => el.getAttribute("data-verdict"));

describe("the split screen, on the real API, worker and demo target", () => {
  it("signs in, runs on both handlers, and shows FAIL against PASS with the real figure", async () => {
    await page.goto(base, { waitUntil: "networkidle0" });
    await page.type('input[name="api-key"]', stack.apiKey);
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => location.pathname === "/scenarios", { timeout: 15_000 });

    // The key stays in this tab, and never in anything that outlives it.
    const stored = await page.evaluate(() => ({
      session: sessionStorage.getItem("murphy.apiKey"),
      local: localStorage.getItem("murphy.apiKey"),
      cookie: document.cookie,
    }));
    expect(stored.session).toBe(stack.apiKey);
    expect(stored.local).toBeNull();
    expect(stored.cookie).not.toContain("mk_");

    const button = await page.waitForSelector("li.scenario .btn--primary", { timeout: 15_000 });
    const first = await page.$eval("li.scenario h2", (el) => el.textContent);
    expect(first).toContain("Duplicate confirmation");
    await button!.click();
    await page.waitForFunction(() => location.pathname === "/compare", { timeout: 15_000 });

    // Live first: no verdict and no figure until the runs have really finished.
    await page.waitForSelector('[data-side="naive"] [data-verdict]', { timeout: 15_000 });
    expect(await verdictOf("naive")).toBe("pending");
    expect(await page.$eval('[data-testid="figure"]', (el) => el.textContent)).toMatch(
      /running|Waiting/i,
    );

    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("[data-side] [data-verdict]")].every(
          (el) => el.getAttribute("data-verdict") !== "pending",
        ),
      { timeout: 60_000 },
    );
    expect(await verdictOf("naive")).toBe("failed");
    expect(await verdictOf("idempotent")).toBe("passed");

    const figure = await page.$eval('[data-testid="figure"]', (el) => el.textContent);
    expect(figure).toContain("Booking effect");
    expect(figure).toContain("2 vs 1, expected 1");

    // Aligned: one row per attempt, each with a real reply on both sides, the duplicate labelled.
    const rows = await page.$$eval(".spine tbody tr", (trs) =>
      trs.map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent ?? "")),
    );
    expect(rows).toHaveLength(3);
    for (const [left, , right] of rows) {
      expect(left).toMatch(/^\+\d+\.\d+s200$/);
      expect(right).toMatch(/^\+\d+\.\d+s200$/);
    }
    expect(rows[2]?.[1]).toContain("Engine: duplicate");

    // A refresh resumes from the URL alone.
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector('[data-verdict="failed"]', { timeout: 15_000 });
    expect(await verdictOf("idempotent")).toBe("passed");

    // The strict CSP did not block anything the page needs.
    expect(problems.filter((p) => /Content Security Policy|hydrat/i.test(p))).toEqual([]);
  }, 150_000);

  it("removes both throwaway endpoints once the reports are stored", async () => {
    const res = await fetch(`${stack.apiUrl}/v1/endpoints`, {
      headers: { authorization: `Bearer ${stack.apiKey}` },
    });
    const { data } = (await res.json()) as { data: { description: string | null }[] };
    expect(data.filter((e) => e.description?.startsWith("murphy run: "))).toEqual([]);
  }, 20_000);
});
