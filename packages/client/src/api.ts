/** Why a request failed, so each caller can word it for its own audience. */
export class MurphyClientError extends Error {
  constructor(
    message: string,
    readonly kind: "api_unreachable" | "api_error" | "target_unreachable" | "target_refused",
    readonly status: number | null = null,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "MurphyClientError";
  }
}

export interface ApiClientOptions {
  apiUrl: string;
  /** An API key (`mk_...`) or a session token. Never logged. */
  token: string;
}

export class MurphyApiClient {
  private readonly apiUrl: string;

  constructor(private readonly options: ApiClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, "");
  }

  async request<T>(
    method: string,
    route: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.apiUrl}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${this.options.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new MurphyClientError(
        `cannot reach the Murphy API at ${this.apiUrl}`,
        "api_unreachable",
      );
    }
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      let code: string | null = null;
      try {
        const parsed = JSON.parse(text) as { error: { message: string; code?: string } };
        message = parsed.error.message;
        code = parsed.error.code ?? null;
      } catch {
        // Not our error format, so show it as it is.
      }
      throw new MurphyClientError(
        `${method} ${route} answered ${res.status}: ${message}`,
        "api_error",
        res.status,
        code,
      );
    }
    if (res.headers.get("content-type")?.includes("json")) return JSON.parse(text) as T;
    return text as T;
  }
}

export interface StartRunInput {
  scenarioId: string;
  endpointId: string;
  stateUrl: string;
  label?: string | null;
  seed?: number;
}

export interface StartedRun {
  id: string;
  seed: number;
}

export function startRun(api: MurphyApiClient, input: StartRunInput): Promise<StartedRun> {
  return api.request<StartedRun>("POST", "/v1/runs", {
    scenario_id: input.scenarioId,
    endpoint_id: input.endpointId,
    state_url: input.stateUrl,
    ...(input.label ? { target_label: input.label } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
  });
}
