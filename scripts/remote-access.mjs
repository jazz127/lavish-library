const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function csv(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function hostnameFromAuthority(authority) {
  if (authority.startsWith('[')) return authority.slice(1, authority.indexOf(']')).toLowerCase();
  return authority.replace(/:\d+$/, '').toLowerCase();
}

function parseOrigins(value, uiPort) {
  if (!value?.trim()) return new Set([`http://localhost:${uiPort}`, `http://127.0.0.1:${uiPort}`]);
  const origins = new Set();
  for (const entry of csv(value)) {
    let parsed;
    try { parsed = new URL(entry); } catch { throw new Error(`Invalid allowed origin: ${entry}`); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== entry || parsed.username || parsed.password) {
      throw new Error(`Allowed origins must be exact http:// or https:// origins without paths: ${entry}`);
    }
    origins.add(parsed.origin);
  }
  return origins;
}

function parseAllowedHosts(value, origins, bindHost) {
  const hosts = new Set([...origins].map((origin) => hostnameFromAuthority(new URL(origin).host)));
  if (value?.trim()) {
    for (const entry of csv(value)) {
      if (entry.includes('*') || /[/:\s]/.test(entry) && !/^\[[0-9a-f:]+\](?::\d+)?$/i.test(entry) && !/^[^/:\s]+(?::\d+)?$/.test(entry)) {
        throw new Error(`Allowed hosts must be explicit hostnames, optionally with ports: ${entry}`);
      }
      hosts.add(hostnameFromAuthority(entry));
    }
  }
  if (!['0.0.0.0', '::', '[::]'].includes(bindHost)) hosts.add(bindHost.replace(/^\[|\]$/g, '').toLowerCase());
  return hosts;
}

export function remoteAccessConfig(env = process.env) {
  const requestedPort = Number(env.LAVISH_TRACKER_UI_PORT || 3000);
  const uiPort = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort <= 65_535 ? requestedPort : 3000;
  const requestedApiPort = Number(env.LAVISH_TRACKER_API_PORT || 4318);
  const apiPort = Number.isInteger(requestedApiPort) && requestedApiPort > 0 && requestedApiPort <= 65_535 ? requestedApiPort : 4318;
  const bindHost = String(env.LAVISH_TRACKER_BIND_HOST || '127.0.0.1').trim();
  if (!bindHost || bindHost.includes('/') || bindHost.includes('*') || /\s/.test(bindHost)) {
    throw new Error('LAVISH_TRACKER_BIND_HOST must be one explicit interface address or hostname.');
  }
  const origins = parseOrigins(env.LAVISH_TRACKER_ALLOWED_ORIGINS, uiPort);
  const isLoopback = LOOPBACK_HOSTS.has(bindHost.toLowerCase());
  if (!isLoopback && !env.LAVISH_TRACKER_ALLOWED_ORIGINS?.trim()) {
    throw new Error('Refusing non-loopback binding without LAVISH_TRACKER_ALLOWED_ORIGINS. Set an explicit comma-separated origin allowlist.');
  }
  const hosts = parseAllowedHosts(env.LAVISH_TRACKER_ALLOWED_HOSTS, origins, bindHost);
  return {
    bindHost,
    origins,
    hosts,
    uiPort,
    apiPort,
    flexibleHostPorts: Boolean(env.LAVISH_TRACKER_ALLOWED_ORIGINS?.trim() || env.LAVISH_TRACKER_ALLOWED_HOSTS?.trim()),
  };
}

export function allowedHost(hostHeader, config) {
  if (!hostHeader) return false;
  const normalized = String(hostHeader).toLowerCase();
  if (!config.flexibleHostPorts) {
    return normalized === `${config.bindHost}:${config.apiPort}` || normalized === `localhost:${config.apiPort}`;
  }
  return config.hosts.has(hostnameFromAuthority(normalized));
}

export function apiBase(env = process.env) {
  return env.LAVISH_TRACKER_API_BASE?.trim() || 'http://127.0.0.1:4318';
}
