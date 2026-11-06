/** Server side only. None of these reach the browser. */
export function apiUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.MURPHY_API_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
}

export function targetOptions(env: NodeJS.ProcessEnv = process.env) {
  return {
    targetUrl: (env.MURPHY_TARGET_URL ?? "http://127.0.0.1:4343").replace(/\/$/, ""),
    adminToken: env.DEMO_TARGET_ADMIN_TOKEN || undefined,
  };
}
