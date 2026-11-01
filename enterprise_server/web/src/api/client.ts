import { t } from '../i18n';

export type TokenProvider = () => string | null;
export type RefreshFn = () => Promise<void>;

/** Thrown when the server rejects a call. `body` carries the parsed JSON
 * error envelope (or null if the server returned a non-JSON response or no
 * body). `status` is the HTTP status code. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: { error?: string; detail?: string; [k: string]: unknown } | null;
  constructor(status: number, body: ApiError['body']) {
    super(`http ${status}${body?.error ? ` ${body.error}` : ''}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Thrown when the server rejected the call AND the session cannot be renewed.
 *
 * The refresh endpoint re-verifies the CURRENT token, so a token that has
 * already expired can never be swapped for a fresh one — the session is
 * genuinely over. The message is user-facing (i18n) so a page's generic
 * `toast.error(e.message)` shows "your session expired" instead of a bare
 * `http 401 unauthorized`. It stays an `ApiError` so every existing
 * `e instanceof ApiError` / `e.status === 401` check keeps working.
 */
export class SessionExpiredError extends ApiError {
  constructor() {
    super(401, null);
    this.name = 'SessionExpiredError';
    this.message = t('auth.session.expired');
  }
}

/** A non-JSON response plus its headers.
 *
 * CSV exports need both halves: the body is the file, and the
 * `x-export-count` header the analytics routes attach carries the row count so
 * the UI can report "exported N records" without parsing the file back. */
export interface RawResponse {
  text: string;
  headers: Headers;
}

/** Build a query string, skipping absent values.
 *
 * `undefined`, `null` and `''` are dropped so a caller can pass an optional
 * filter straight through (`{ q: search || undefined }`) without assembling
 * params by hand. `0` is kept — it is a real value for `page`.
 *
 * The parameter is `object`, not a `Record`, so an interface with named fields
 * is accepted as-is; an interface has no index signature and would otherwise be
 * rejected by the `Record` form. */
/** The download filename a response asked for, or `fallback`.
 *
 * The analytics and audit CSV routes name their files deliberately
 * (`7d-模型用量.csv`, `30d-审计记录.csv`) and the range key in that name is what
 * makes an archived file self-describing. A client that invents its own name
 * discards that, and drifts the moment either side changes — so the server's
 * `content-disposition` wins and `fallback` is only for a response that
 * carries no header at all.
 *
 * Only the RFC 5987 extended form is emitted by `csvResponse` (a bare
 * `filename="…"` is invalid when the value is non-ASCII, and these names are
 * Chinese), but the plain form is accepted too: it costs one regex and keeps
 * this usable against a proxy that rewrites the header. */
export function filenameFromDisposition(headers: Headers, fallback: string): string {
  const cd = headers.get('content-disposition');
  if (!cd) return fallback;
  // `filename*=UTF-8''<percent-encoded>` — the charset is informational here;
  // we always decode as UTF-8, which is the only charset this app emits.
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(cd);
  if (star) {
    try {
      const name = decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
      if (name) return name;
    } catch {
      // Malformed percent-encoding: fall through to the plain form rather
      // than downloading a file called `filename*=UTF-8''%`.
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  return plain?.[1].trim() || fallback;
}

export function buildQuery(params: object): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    q.set(key, String(value));
  }
  return q.toString();
}

interface ApiClient {
  baseUrl(): string;
  setBaseUrl(url: string): void;
  setTokenProvider(fn: TokenProvider): void;
  setRefresh(fn: RefreshFn | null): void;
  setSessionExpiredHandler(fn: (() => void) | null): void;
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown): Promise<T>;
  put<T = unknown>(path: string, body?: unknown): Promise<T>;
  delete<T = void>(path: string): Promise<T>;
  getRaw(path: string): Promise<string>;
  getRawWithHeaders(path: string): Promise<RawResponse>;
  postRaw<T = unknown>(path: string, body: BodyInit, headers?: Record<string, string>): Promise<T>;
}

let baseUrl = '';
let tokenProvider: TokenProvider = () => null;
let refresh: RefreshFn = async () => {};
/** Called when the session is known to be dead, so the app can send the
 *  admin back to the login page instead of silently failing every request. */
let onSessionExpired: (() => void) | null = null;

/** Auth endpoints must NEVER trigger the refresh-on-401 flow. If we did,
 * `POST /auth/login` returning 401 (invalid creds) would call
 * `POST /auth/refresh`, which would itself return 401 (no token yet) and
 * recursively re-trigger `/auth/login` style refresh attempts — an infinite
 * 401 storm that wedges the SPA with the submit button stuck at `[disabled]`
 * and the user seeing no error feedback at all. */
function shouldSkipRefresh(path: string): boolean {
  return path === '/auth/login' || path === '/auth/refresh';
}

function buildHeaders(init?: HeadersInit): Headers {
  const h = new Headers(init);
  const tok = tokenProvider();
  if (tok) h.set('authorization', `Bearer ${tok}`);
  h.set('content-type', 'application/json');
  return h;
}

async function readErrorBody(res: Response): Promise<ApiError['body']> {
  const text = await res.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text) as ApiError['body'];
  } catch {
    return null;
  }
}

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  retried = false
): Promise<T> {
  const init: RequestInit = {
    method,
    headers: buildHeaders(),
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, init);
  } catch (e) {
    throw new ApiError(0, { error: 'network', detail: (e as Error).message });
  }
  if (res.status === 401 && !retried && !shouldSkipRefresh(path)) {
    try {
      await refresh();
    } catch (e) {
      // A refresh that 401s means the session is dead: the refresh endpoint
      // re-verifies the CURRENT token, so a lapsed one can never be renewed.
      // Clear the session so the app returns to the login page, and say so
      // in words the admin can act on. A refresh that failed for a NETWORK
      // reason is not a dead session — keep the original 401 and the session.
      if (e instanceof ApiError && e.status === 401) {
        onSessionExpired?.();
        throw new SessionExpiredError();
      }
      // Surface the ORIGINAL 401 from the first request so the caller can
      // show "session expired" or similar — not the refresh's downstream error.
      throw new ApiError(401, await readErrorBody(res));
    }
    return call<T>(method, path, body, true);
  }
  if (!res.ok) throw new ApiError(res.status, await readErrorBody(res));
  const text = await res.text();
  return (text ? JSON.parse(text) : (undefined as T)) as T;
}

export const apiClient: ApiClient = {
  baseUrl: () => baseUrl,
  setBaseUrl: (url) => {
    baseUrl = url.replace(/\/$/, '');
  },
  setTokenProvider: (fn) => {
    tokenProvider = fn;
  },
  setRefresh: (fn) => {
    refresh = fn ?? (async () => {});
  },
  setSessionExpiredHandler: (fn) => {
    onSessionExpired = fn;
  },
  get: <T>(p: string) => call<T>('GET', p),
  post: <T>(p: string, body?: unknown) => call<T>('POST', p, body),
  patch: <T>(p: string, body?: unknown) => call<T>('PATCH', p, body),
  put: <T>(p: string, body?: unknown) => call<T>('PUT', p, body),
  delete: <T = void>(p: string) => call<T>('DELETE', p),
  async getRaw(path: string): Promise<string> {
    return (await apiClient.getRawWithHeaders(path)).text;
  },
  async getRawWithHeaders(path: string): Promise<RawResponse> {
    const res = await fetch(`${baseUrl}${path}`, { headers: buildHeaders() });
    if (!res.ok) throw new ApiError(res.status, await readErrorBody(res));
    return { text: await res.text(), headers: res.headers };
  },
  async postRaw<T>(path: string, body: BodyInit, headers: Record<string, string> = {}): Promise<T> {
    const h = buildHeaders(headers);
    if (body instanceof FormData) {
      // The browser must write `multipart/form-data; boundary=…` itself. Any
      // content-type we set here wins over it, the server cannot find the
      // boundary, and every field arrives missing — which is why an icon
      // upload failed with a message about the image type.
      h.delete('content-type');
    } else {
      // Set by the caller for a raw body (e.g. application/zip); do not force JSON.
      h.set('content-type', headers['content-type'] ?? 'application/octet-stream');
    }
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: h, body });
    } catch (e) {
      throw new ApiError(0, { error: 'network', detail: (e as Error).message });
    }
    if (!res.ok) throw new ApiError(res.status, await readErrorBody(res));
    const text = await res.text();
    return (text ? JSON.parse(text) : (undefined as T)) as T;
  },
};