// @vitest-environment node
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer as createHttpServer, type Server } from "node:http";
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
let mockGithub: Server;
const INTERNAL_SECRET = "e2e-internal-secret-not-a-real-one";
const problems: string[] = [];

/** Stands in for GitHub: approves at once, and checks what a real one would check. */
function startMockGithub(port: number, expectedCallback: string): Server {
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname === "/login/oauth/authorize") {
      if (url.searchParams.get("redirect_uri") !== expectedCallback) {
        res.writeHead(400).end("bad redirect_uri");
        return;
      }
      const back = new URL(expectedCallback);
      back.searchParams.set("code", "mock-code");
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { location: back.toString() }).end();
    } else if (url.pathname === "/login/oauth/access_token") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "gho_mock" }));
    } else if (url.pathname === "/user") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: 7777, login: "udita-0707" }));
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(port, "127.0.0.1");
  return server;
}

beforeAll(async () => {
  stack = await startStack({ MURPHY_INTERNAL_SECRET: INTERNAL_SECRET });
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
  const githubPort = await freePort();
  mockGithub = startMockGithub(githubPort, `${base}/auth/github/callback`);
  dashboard = spawn("pnpm", ["exec", "next", "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd,
    env: {
      ...env,
      NODE_ENV: "production",
      MURPHY_MODE: "local",
      DASHBOARD_URL: base,
      GITHUB_CLIENT_ID: "mock-client",
      GITHUB_CLIENT_SECRET: "mock-secret",
      MURPHY_INTERNAL_SECRET: INTERNAL_SECRET,
      GITHUB_WEB_URL: `http://127.0.0.1:${githubPort}`,
      GITHUB_API_URL: `http://127.0.0.1:${githubPort}`,
    },
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
  mockGithub?.close();
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
    await page.goto(`${base}/login`, { waitUntil: "networkidle0" });
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

  it("downloads the comparison as one file that works with the network blocked", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "murphy-export-"));
    try {
      const cdp = await browser.target().createCDPSession();
      await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir });
      const [button] = await page.$$("xpath/.//button[contains(., 'Download comparison')]");
      await button!.click();
      const deadline = Date.now() + 15_000;
      let name: string | undefined;
      while (!name) {
        name = readdirSync(dir).find((f) => f.endsWith(".html"));
        if (!name && Date.now() > deadline) throw new Error("nothing was downloaded");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(name).toBe("murphy-booking-duplicate-confirmation-comparison.html");
      const html = readFileSync(path.join(dir, name), "utf8");
      expect(html).toContain("2 vs 1, expected 1");

      const offline = await browser.newPage();
      const requests: string[] = [];
      offline.on("request", (r) => requests.push(r.url()));
      await offline.setViewport({ width: 1280, height: 800 });
      await offline.setOfflineMode(true);
      await offline.goto(`file://${path.join(dir, name)}`, { waitUntil: "load" });
      const seen = await offline.evaluate(async () => {
        await document.fonts.ready;
        return {
          fail: !!document.querySelector(".verdict--failed"),
          pass: !!document.querySelector(".verdict--passed"),
          font: document.fonts.check('800 96px "Chivo Mono"'),
          background: getComputedStyle(document.body).backgroundColor,
        };
      });
      await offline.close();
      expect(seen.fail && seen.pass && seen.font).toBe(true);
      expect(seen.background).not.toBe("rgba(0, 0, 0, 0)");
      expect(requests.filter((u) => !u.startsWith("file:") && !u.startsWith("data:"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("removes both throwaway endpoints once the reports are stored", async () => {
    const res = await fetch(`${stack.apiUrl}/v1/endpoints`, {
      headers: { authorization: `Bearer ${stack.apiKey}` },
    });
    const { data } = (await res.json()) as { data: { description: string | null }[] };
    expect(data.filter((e) => e.description?.startsWith("murphy run: "))).toEqual([]);
  }, 20_000);
});

describe("GitHub login, in a real browser against a mock GitHub", () => {
  it("signs in with a cookie scripts cannot read, changes things with CSRF, and signs out for good", async () => {
    const context = await browser.createBrowserContext();
    const tab = await context.newPage();
    try {
      await tab.goto(`${base}/login`, { waitUntil: "networkidle0" });
      await tab.click('a[href="/auth/github/start"]');
      await tab.waitForFunction(() => location.pathname === "/scenarios", { timeout: 20_000 });

      const cookies = await context.cookies();
      const session = cookies.find((c) => c.name === "murphy_session");
      expect(session?.httpOnly).toBe(true);
      expect(session?.sameSite).toBe("Lax");
      expect(session?.value.startsWith("ms_")).toBe(true);
      expect(cookies.find((c) => c.name === "murphy_oauth")).toBeUndefined();
      expect(cookies.map((c) => c.value).join()).not.toContain("gho_");

      const seen = await tab.evaluate(() => ({
        cookie: document.cookie,
        key: sessionStorage.getItem("murphy.apiKey"),
      }));
      expect(seen.cookie).not.toContain("ms_");
      expect(seen.cookie).toContain("murphy_csrf=");
      expect(seen.key).toBeNull();

      // A real change, through the cookie and the CSRF token: start a run on one handler.
      await tab.waitForSelector("li.scenario", { timeout: 15_000 });
      await tab.click('button[aria-label="Run on naive only"]');
      await tab.waitForFunction(() => location.pathname.startsWith("/runs/"), { timeout: 20_000 });

      // The same request without the CSRF token is refused.
      const refused = await tab.evaluate(async () => {
        const res = await fetch("/api/v1/endpoints", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "http://127.0.0.1:1/x" }),
        });
        return res.status;
      });
      expect(refused).toBe(403);

      // Sign out, and the old token no longer works anywhere.
      const [signOut] = await tab.$$("xpath/.//button[contains(., 'Sign out')]");
      await signOut!.click();
      await tab.waitForFunction(() => location.pathname === "/login", { timeout: 15_000 });
      const res = await fetch(`${stack.apiUrl}/v1/scenarios`, {
        headers: { authorization: `Bearer ${session!.value}` },
      });
      expect(res.status).toBe(401);
    } finally {
      await context.close();
    }
  }, 90_000);

  it("the login page offers GitHub next to the API key", async () => {
    const html = await fetch(`${base}/login`).then((r) => r.text());
    expect(html).toContain('href="/auth/github/start"');
    expect(html).toContain('name="api-key"');
  }, 20_000);
});
