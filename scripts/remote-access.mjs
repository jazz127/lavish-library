const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host || '').toLowerCase().replace(/^::ffff:/, ''));
}

export function hostAuthority(host) {
  return host.includes(':') ? `[${host}]` : host;
}

function csv(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function hostnameFromAuthority(authority) {
  if (authority.startsWith('[')) return authority.slice(1, authority.indexOf(']')).toLowerCase();
  return authority.replace(/:\d+$/, '').toLowerCase();
}

function parseOrigins(value, uiPort, bindHost) {
  if (!value?.trim()) return new Set([`http://localhost:${uiPort}`, `http://127.0.0.1:${uiPort}`, ...(bindHost === '::1' ? [`http://[::1]:${uiPort}`] : [])]);
  const origins = new Set();
  for (const entry of csv(value)) {
    let parsed;
    try { parsed = new URL(entry); } catch { throw new Error(`Invalid allowed origin: ${entry}`); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== entry || parsed.username || parsed.password || parsed.hostname.includes('*')) {
      throw new Error(`Allowed origins must be exact http:// or https:// origins without paths: ${entry}`);
    }
    origins.add(parsed.origin);
  }
  if (!origins.size) throw new Error('Allowed origins must contain at least one exact http:// or https:// origin.');
  return origins;
}

function parseAllowedHosts(origins, bindHost) {
  const hosts = new Set([...origins].map((origin) => hostnameFromAuthority(new URL(origin).host)));
  if (!['0.0.0.0', '::'].includes(bindHost)) hosts.add(bindHost.toLowerCase());
  return hosts;
}

export function remoteAccessConfig(env = process.env) {
  const requestedPort = Number(env.LAVISH_TRACKER_UI_PORT || 3000);
  const uiPort = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort <= 65_535 ? requestedPort : 3000;
  const requestedApiPort = Number(env.LAVISH_TRACKER_API_PORT || 4318);
  const apiPort = Number.isInteger(requestedApiPort) && requestedApiPort > 0 && requestedApiPort <= 65_535 ? requestedApiPort : 4318;
  const bindHost = String(env.LAVISH_TRACKER_BIND_HOST || '127.0.0.1').trim().replace(/^\[([^\]]+)\]$/, '$1');
  if (!bindHost || bindHost.includes('/') || bindHost.includes('*') || /\s/.test(bindHost)) {
    throw new Error('LAVISH_TRACKER_BIND_HOST must be one explicit interface address or hostname.');
  }
  const origins = parseOrigins(env.LAVISH_TRACKER_ALLOWED_ORIGINS, uiPort, bindHost);
  const isLoopback = isLoopbackHost(bindHost);
  if (!isLoopback && !env.LAVISH_TRACKER_ALLOWED_ORIGINS?.trim()) {
    throw new Error('Refusing non-loopback binding without LAVISH_TRACKER_ALLOWED_ORIGINS. Set an explicit comma-separated origin allowlist.');
  }
  const hosts = parseAllowedHosts(origins, bindHost);
  return {
    bindHost,
    origins,
    hosts,
    uiPort,
    apiPort,
    isLoopback,
    flexibleHostPorts: Boolean(env.LAVISH_TRACKER_ALLOWED_ORIGINS?.trim()),
  };
}

export function allowedHost(hostHeader, config) {
  if (!hostHeader) return false;
  const normalized = String(hostHeader).toLowerCase();
  if (!config.flexibleHostPorts) {
    return normalized === `${hostAuthority(config.bindHost).toLowerCase()}:${config.apiPort}` || normalized === `localhost:${config.apiPort}`;
  }
  return config.hosts.has(hostnameFromAuthority(normalized));
}

export function apiBase(env = process.env) {
  const value = env.LAVISH_TRACKER_API_BASE?.trim() || 'http://127.0.0.1:4318';
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('LAVISH_TRACKER_API_BASE must be an absolute http:// or https:// URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('LAVISH_TRACKER_API_BASE must be an absolute http:// or https:// URL without credentials, query, or fragment.');
  }
  return parsed.href.replace(/\/$/, '');
}
