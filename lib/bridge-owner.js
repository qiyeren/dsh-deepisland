import * as nodeNet from 'node:net';

// Shared by every participating instance, regardless of its bridge data port.
// This is a machine/network-namespace-wide reservation, not authentication:
// unrelated programs can occupy it; old versions that do not reserve it can
// still run concurrently. There is deliberately no lockfile or stale-lock logic.
export const BRIDGE_OWNER_HOST = '127.0.0.1';
export const BRIDGE_OWNER_PORT = 47312;

/**
 * Reserve the bridge owner sentinel. Rejects on *any* bind failure.
 * `net` is injectable for offline testing and must implement createServer().
 * The caller must start the bridge only after this resolves, retain the handle
 * for the entire bridge lifetime, and stop the bridge if `lost` yields an
 * Error. Stop the bridge before awaiting close(). `lost` yields null on a
 * normal close. There is no automatic retry or cancellation.
 *
 * @param {{net?: typeof nodeNet}} [options]
 * @returns {Promise<{close: () => Promise<void>, lost: Promise<Error|null>}>}
 */
export function acquireBridgeOwner({ net = nodeNet } = {}) {
  return new Promise((resolve, reject) => {
    let server;
    let phase = 'acquiring';
    let closePromise;
    let resolveLost;
    const lost = new Promise((done) => { resolveLost = done; });

    // Always use the same promise, including when concurrent callers close.
    function closeServer() {
      if (!closePromise) {
        closePromise = new Promise((done, fail) => {
          try {
            server.close((error) => error ? fail(error) : done());
          } catch (error) {
            fail(error);
          }
        });
      }
      return closePromise;
    }

    function failAcquire(error) {
      if (phase !== 'acquiring') return;
      phase = 'failed';
      // A failed listen usually leaves no running server; close anyway, without
      // replacing the original failure with ERR_SERVER_NOT_RUNNING.
      if (server) void closeServer().catch(() => {});
      reject(error);
    }

    function loseOwnership(error) {
      if (phase !== 'owned') return;
      phase = 'lost';
      resolveLost(error);
      // The caller shuts down the data bridge first, then explicitly closes
      // this reservation. If the sentinel has already closed unexpectedly, the
      // OS may have released it and this ordering cannot be guaranteed.
    }

    try {
      server = net.createServer((socket) => {
        // The sentinel is not a service and must not retain clients on close.
        socket.on('error', () => {});
        socket.destroy();
      });
      server.on('error', (error) => {
        if (phase === 'acquiring') failAcquire(error);
        else loseOwnership(error);
      });
      server.on('close', () => {
        if (phase === 'acquiring') failAcquire(new Error('Bridge owner sentinel closed before listening'));
        else if (phase === 'owned') loseOwnership(new Error('Bridge owner sentinel closed unexpectedly'));
      });
      server.once('listening', () => {
        if (phase !== 'acquiring') return;
        phase = 'owned';
        resolve({
          lost,
          close() {
            if (phase === 'owned') {
              phase = 'closing';
              resolveLost(null);
            }
            return closeServer();
          },
        });
      });
      server.listen({ host: BRIDGE_OWNER_HOST, port: BRIDGE_OWNER_PORT, exclusive: true });
    } catch (error) {
      failAcquire(error);
    }
  });
}
