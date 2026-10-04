declare const __LAVISH_TRACKER_API_BASE__: string;

const API_BASE = (typeof __LAVISH_TRACKER_API_BASE__ === 'string'
  ? __LAVISH_TRACKER_API_BASE__
  : 'http://127.0.0.1:4318');

let tokenPromise: Promise<string> | null = null;

async function sessionToken() {
  if (!tokenPromise) {
    tokenPromise = fetch(`${API_BASE}/api/session`, { cache: 'no-store' })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok || typeof result.token !== 'string') throw new Error(result.error || 'Could not authorize the local library service.');
        return result.token;
      })
      .catch((error) => {
        tokenPromise = null;
        throw error;
      });
  }
  return tokenPromise;
}

async function request(path: string, init: RequestInit, retry: boolean): Promise<Response> {
  const token = await sessionToken();
  const headers = new Headers(init.headers);
  headers.set('x-lavish-token', token);
  const response = await fetch(`${API_BASE}/api${path}`, { ...init, headers });
  if (response.status === 401 && retry) {
    tokenPromise = null;
    return request(path, init, false);
  }
  return response;
}

export function apiFetch(path: string, init: RequestInit = {}) {
  return request(path, init, true);
}
