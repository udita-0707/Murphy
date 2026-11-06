import { apiUrl } from "@/lib/server-config";

export const dynamic = "force-dynamic";

const errorBody = (code: string, message: string) => ({ error: { code, message } });

/** Forwards to the API, and adds nothing else (ADR 013). Tenant checks stay in the API. */
async function forward(request: Request, path: string[]): Promise<Response> {
  if (
    path.some((part) => part === "." || part === ".." || part.includes("/") || part.includes("\\"))
  ) {
    return Response.json(errorBody("not_found", "route not found"), { status: 404 });
  }
  const headers = new Headers();
  for (const name of ["authorization", "content-type", "idempotency-key"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const search = new URL(request.url).search;
  const route = path.map(encodeURIComponent).join("/");
  let upstream: Response;
  try {
    upstream = await fetch(`${apiUrl()}/v1/${route}${search}`, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      cache: "no-store",
    });
  } catch {
    return Response.json(errorBody("api_unreachable", "The Murphy API cannot be reached."), {
      status: 502,
    });
  }
  const out = new Headers({ "cache-control": "no-store" });
  const type = upstream.headers.get("content-type");
  if (type) out.set("content-type", type);
  return new Response(upstream.status === 204 ? null : await upstream.arrayBuffer(), {
    status: upstream.status,
    headers: out,
  });
}

type Context = { params: Promise<{ path: string[] }> };
const handler = async (request: Request, context: Context) =>
  forward(request, (await context.params).path);

export { handler as GET, handler as POST, handler as PATCH, handler as DELETE };
