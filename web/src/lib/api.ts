export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Json = Record<string, unknown> | unknown[] | null;

async function request<T>(method: string, path: string, body?: Json): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'x-hrone': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = (data as { error?: string })?.error ?? (typeof data === 'string' && data ? data : `요청 실패 (${res.status})`);
    if (res.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event('hrone:unauthorized'));
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export const api = {
  get: <T = any>(path: string) => request<T>('GET', path),
  post: <T = any>(path: string, body: Json = {}) => request<T>('POST', path, body),
  put: <T = any>(path: string, body: Json = {}) => request<T>('PUT', path, body),
  patch: <T = any>(path: string, body: Json = {}) => request<T>('PATCH', path, body),
  del: <T = any>(path: string) => request<T>('DELETE', path),
};

export function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
