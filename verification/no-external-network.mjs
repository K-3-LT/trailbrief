import net from 'node:net';
const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const realFetch = globalThis.fetch;
globalThis.fetch = (input, ...args) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!loopback.has(url.hostname)) throw new Error('Offline verification blocked external fetch');
  return realFetch(input, ...args);
};
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  let host;
  if (typeof first === 'object' && first !== null) {
    if (first.path) throw new Error('Offline verification blocked non-TCP socket');
    host = first.host || 'localhost';
  } else if (typeof first === 'number') {
    host = typeof args[1] === 'string' ? args[1] : 'localhost';
  } else throw new Error('Offline verification blocked unknown socket destination');
  if (!loopback.has(host)) throw new Error('Offline verification blocked external socket');
  return realConnect.apply(this, args);
};
