import type { ApiErrorBody } from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly currentVersion?: number;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message ?? `The local service returned ${status}.`);
    this.name = "ApiError";
    this.status = status;
    this.code = body.error;
    this.currentVersion = body.currentVersion;
  }
}

export async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    let body: ApiErrorBody = {};
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      // The server can close the connection during restart without returning JSON.
    }
    throw new ApiError(response.status, body);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function jsonRequest(method: "POST" | "PUT" | "DELETE", body?: unknown): RequestInit {
  return { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}
