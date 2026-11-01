// Exact /api routes are protected by the DSH Connection carrier's trust/auth
// checks. This module does not create a listener or access configuration itself.
const CONFIG_PATH = '/api/dsh-vibe-island/config';
const NEXT_PATH = '/api/dsh-vibe-island/next';
const MAX_CONFIG_BYTES = 64 * 1024;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * Register browser routes. getBridge is a synchronous snapshot: return null
 * while bridgeReady is pending/failed, otherwise its resolved bridge object.
 * A reused bridge's drain is a placeholder, not the owner queue.
 * Returns an idempotent async disposer. No route performs authentication itself;
 * callers must mount these routes on the authenticated Connection /api carrier.
 */
export async function registerBrowserApi(connection, { readConfig, writeConfig, getBridge }) {
  if (typeof connection?.fetch?.register !== 'function' ||
      typeof readConfig !== 'function' || typeof writeConfig !== 'function' ||
      typeof getBridge !== 'function') {
    throw new TypeError('connection.fetch.register and all callbacks are required');
  }

  const configRoute = {
    path: CONFIG_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        if (request.method === 'GET') return json({ ok: true, config: await readConfig() });
        if (request.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);
        const mediaType = (request.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
        if (mediaType !== 'application/json') return json({ ok: false, error: 'expected application/json' }, 415);
        const length = request.headers.get('content-length');
        if (length && /^\d+$/.test(length) && BigInt(length) > BigInt(MAX_CONFIG_BYTES)) {
          return json({ ok: false, error: 'request body too large' }, 413);
        }
        const bytes = await request.arrayBuffer();
        if (bytes.byteLength > MAX_CONFIG_BYTES) return json({ ok: false, error: 'request body too large' }, 413);
        let raw;
        try {
          raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          JSON.parse(raw);
        } catch {
          return json({ ok: false, error: 'invalid JSON' }, 400);
        }
        const result = await writeConfig(raw);
        return json(result, result?.ok === true ? 200 : 400);
      } catch {
        return json({ ok: false, error: 'internal error' }, 500);
      }
    },
  };
  const nextRoute = {
    path: NEXT_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);
      try {
        const bridge = getBridge();
        if (!bridge || bridge.reused || typeof bridge.drain !== 'function') {
          return json({ ok: false, error: 'bridge not ready' }, 503);
        }
        const items = await bridge.drain();
        if (!Array.isArray(items)) return json({ ok: false, error: 'invalid bridge response' }, 503);
        return json({ ok: true, items });
      } catch {
        return json({ ok: false, error: 'bridge unavailable' }, 503);
      }
    },
  };

  const disposers = [];
  let disposal;
  const dispose = () => {
    if (!disposal) disposal = (async () => {
      const errors = [];
      for (const unregister of disposers.splice(0).reverse()) {
        try { await unregister(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'browser API unregister failed');
    })();
    return disposal;
  };
  try {
    for (const route of [configRoute, nextRoute]) {
      const unregister = connection.fetch.register(route);
      if (typeof unregister !== 'function') throw new TypeError('register must return an unregister function');
      disposers.push(unregister);
    }
  } catch (error) {
    try { await dispose(); } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'browser API registration and rollback failed');
    }
    throw error;
  }
  return dispose;
}
