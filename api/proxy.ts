import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX_BODY_BYTES = 64 * 1024;
const PROXY_PATH_PARAM = '__orderseal_path';

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function resolveUpstreamUrl(requestUrl: string | undefined, origin: URL): URL | null {
  const incomingUrl = new URL(requestUrl ?? '/api/proxy', 'https://orderseal.invalid');
  const rewrittenPath = incomingUrl.searchParams.get(PROXY_PATH_PARAM);
  const segments = rewrittenPath?.split('/') ?? [];
  if (
    !rewrittenPath
    || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(rewrittenPath)
    || segments.some((segment) => segment === '.' || segment === '..')
  ) {
    return null;
  }

  incomingUrl.searchParams.delete(PROXY_PATH_PARAM);
  const upstreamUrl = new URL(`/api/${rewrittenPath}`, origin);
  for (const [name, value] of incomingUrl.searchParams) upstreamUrl.searchParams.append(name, value);
  return upstreamUrl;
}

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const configuredOrigin = process.env.ORDERSEAL_API_ORIGIN;
  if (!configuredOrigin) {
    sendJson(response, 503, { error: { code: 'API_ORIGIN_NOT_CONFIGURED', message: 'The persistent API origin is not configured.' } });
    return;
  }

  let origin: URL;
  try {
    origin = new URL(configuredOrigin);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/') throw new Error();
  } catch {
    sendJson(response, 503, { error: { code: 'INVALID_API_ORIGIN', message: 'The persistent API origin is invalid.' } });
    return;
  }

  const upstreamUrl = resolveUpstreamUrl(request.url, origin);
  if (!upstreamUrl) {
    sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Unknown API route.' } });
    return;
  }
  const headers = new Headers();
  for (const name of ['accept', 'authorization', 'content-type'] as const) {
    const value = request.headers[name];
    if (typeof value === 'string') headers.set(name, value);
  }

  let body: Buffer | undefined;
  try {
    body = await readBody(request);
  } catch {
    sendJson(response, 413, { error: { code: 'REQUEST_TOO_LARGE', message: 'The request body is too large.' } });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: body ? new Uint8Array(body) : undefined,
      redirect: 'manual',
      signal: controller.signal,
    });
    response.statusCode = upstream.status;
    response.setHeader('cache-control', 'no-store');
    const contentType = upstream.headers.get('content-type');
    if (contentType) response.setHeader('content-type', contentType);
    const retryAfter = upstream.headers.get('retry-after');
    if (retryAfter) response.setHeader('retry-after', retryAfter);
    if (request.method === 'HEAD') response.end();
    else response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    sendJson(response, 502, { error: { code: 'API_UNAVAILABLE', message: 'The persistent OrderSeal API could not be reached.' } });
  } finally {
    clearTimeout(timeout);
  }
}
