import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { acquireBridgeOwner, BRIDGE_OWNER_HOST, BRIDGE_OWNER_PORT } from '../lib/bridge-owner.js';

// Entirely in memory: no net.Server, sockets, configuration or bridge process.
function fakeNet() {
  const reservations = new Map();
  const servers = [];
  const net = {
    servers,
    reservations,
    failure: null,
    createServer(connection) {
      const server = new EventEmitter();
      server.connection = connection;
      server.closeCalls = 0;
      server.listening = false;
      server.listen = (options) => {
        server.options = options;
        if (net.failure?.sync) throw net.failure.sync;
        queueMicrotask(() => {
          if (net.failure?.async) return server.emit('error', net.failure.async);
          const key = `${options.host}:${options.port}`;
          if (reservations.has(key)) {
            const error = Object.assign(new Error('address in use'), { code: 'EADDRINUSE' });
            return server.emit('error', error);
          }
          reservations.set(key, server);
          server.key = key;
          server.listening = true;
          server.emit('listening');
        });
        return server;
      };
      server.close = (callback) => {
        server.closeCalls++;
        if (!server.listening) {
          queueMicrotask(() => callback(Object.assign(new Error('not running'), { code: 'ERR_SERVER_NOT_RUNNING' })));
          return server;
        }
        server.listening = false;
        reservations.delete(server.key);
        queueMicrotask(() => {
          server.emit('close');
          callback();
        });
        return server;
      };
      servers.push(server);
      return server;
    },
  };
  return net;
}

test('exclusive fixed loopback reservation wins one parallel acquisition', async () => {
  const net = fakeNet();
  const results = await Promise.allSettled([
    acquireBridgeOwner({ net }), acquireBridgeOwner({ net }), acquireBridgeOwner({ net }),
  ]);
  const winners = results.filter((result) => result.status === 'fulfilled');
  const failures = results.filter((result) => result.status === 'rejected');
  assert.equal(winners.length, 1);
  assert.equal(failures.length, 2);
  for (const failure of failures) assert.equal(failure.reason.code, 'EADDRINUSE');
  assert.notEqual(BRIDGE_OWNER_PORT, 47311);
  for (const server of net.servers) {
    assert.deepEqual(server.options, { host: '127.0.0.1', port: BRIDGE_OWNER_PORT, exclusive: true });
  }
  assert.equal(BRIDGE_OWNER_HOST, '127.0.0.1');
  assert.equal(net.reservations.size, 1);
  assert.equal(net.servers[1].closeCalls, 1);
  assert.equal(net.servers[2].closeCalls, 1);
  await winners[0].value.close();
  assert.equal(await winners[0].value.lost, null);
  assert.equal(net.reservations.size, 0);
});

test('close is async, idempotent and allows a later acquisition', async () => {
  const net = fakeNet();
  const first = await acquireBridgeOwner({ net });
  const close1 = first.close();
  const close2 = first.close();
  assert.strictEqual(close1, close2);
  await close1;
  await first.close();
  assert.equal(net.servers[0].closeCalls, 1);
  const next = await acquireBridgeOwner({ net });
  await next.close();
});

test('sync and asynchronous listen failures reject and clean up, then permit retry', async () => {
  for (const kind of ['sync', 'async']) {
    const net = fakeNet();
    const error = new Error(`${kind} failure`);
    net.failure = { [kind]: error };
    await assert.rejects(acquireBridgeOwner({ net }), (actual) => actual === error);
    assert.equal(net.servers[0].closeCalls, 1);
    assert.equal(net.reservations.size, 0);
    net.failure = null;
    const owner = await acquireBridgeOwner({ net });
    await owner.close();
  }
});

test('createServer failures reject without a handle', async () => {
  const error = new Error('cannot create');
  await assert.rejects(acquireBridgeOwner({ net: { createServer() { throw error; } } }), (actual) => actual === error);
});

test('owned server error keeps reservation until caller closes after shutdown', async () => {
  const net = fakeNet();
  const owner = await acquireBridgeOwner({ net });
  const error = new Error('sentinel failed');
  net.servers[0].emit('error', error);
  assert.strictEqual(await owner.lost, error);
  assert.equal(net.reservations.size, 1, 'keep reservation until caller stops the data bridge');
  await assert.rejects(acquireBridgeOwner({ net }), { code: 'EADDRINUSE' });
  await owner.close();
  assert.equal(net.servers[0].closeCalls, 1);
  const next = await acquireBridgeOwner({ net });
  await next.close();
});

test('unexpected close signals loss rather than a normal release', async () => {
  const net = fakeNet();
  const owner = await acquireBridgeOwner({ net });
  await new Promise((resolve) => net.servers[0].close(resolve));
  const loss = await owner.lost;
  assert.match(loss.message, /closed unexpectedly/);
  await assert.rejects(owner.close(), { code: 'ERR_SERVER_NOT_RUNNING' });
  const next = await acquireBridgeOwner({ net });
  await next.close();
});

test('close callback failure is propagated consistently', async () => {
  const net = fakeNet();
  const owner = await acquireBridgeOwner({ net });
  const error = new Error('close failed');
  let calls = 0;
  net.servers[0].close = (callback) => { calls++; queueMicrotask(() => callback(error)); };
  const first = owner.close();
  assert.strictEqual(first, owner.close());
  await assert.rejects(first, (actual) => actual === error);
  await assert.rejects(owner.close(), (actual) => actual === error);
  assert.equal(calls, 1);
});

test('close before listening is a failed acquisition', async () => {
  const net = fakeNet();
  const create = net.createServer;
  net.createServer = (connection) => {
    const server = create(connection);
    server.listen = () => { queueMicrotask(() => server.emit('close')); };
    return server;
  };
  await assert.rejects(acquireBridgeOwner({ net }), /closed before listening/);
  assert.equal(net.servers[0].closeCalls, 1);
  assert.equal(net.reservations.size, 0);
});

test('connections are immediately destroyed without serving any data', async () => {
  const net = fakeNet();
  const owner = await acquireBridgeOwner({ net });
  const socket = new EventEmitter();
  let destroyed = false;
  socket.destroy = () => { destroyed = true; };
  net.servers[0].connection(socket);
  assert.equal(destroyed, true);
  socket.emit('error', new Error('ignored connection error'));
  await owner.close();
});
