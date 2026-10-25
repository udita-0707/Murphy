export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const notFound = (what = "resource") => new ApiError(404, "not_found", `${what} not found`);

export const unauthorized = (message = "missing or invalid API key") =>
  new ApiError(401, "unauthorized", message, { "WWW-Authenticate": "Bearer" });

export interface ErrorBody {
  error: { code: string; message: string; request_id: string };
}
