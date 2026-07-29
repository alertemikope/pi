# @earendil-works/pi-server

Node.js Unix-domain socket server for durable remote pi sessions over the transport-neutral framed CBOR protocol. The package depends on an injected session backend instead of `@earendil-works/pi-coding-agent`.

This package and protocol are experimental and have no compatibility guarantees. Network transports are intentionally deferred while the protocol and session architecture stabilize.

## Usage

```ts
import {
  PiServer,
  type PiSessionBackend,
} from "@earendil-works/pi-server";

const backend: PiSessionBackend = {
  async listSessions() {
    return storage.listSessions();
  },
  async listModels() {
    return modelRegistry.listModels();
  },
  async createSession(options) {
    // Persist options.id exactly and acquire that session's exclusive lock.
    return storage.createAndOpen(options);
  },
  async openSession(sessionId) {
    // Acquire an exclusive lock or throw SessionLockedError.
    return storage.open(sessionId);
  },
};

const server = new PiServer(backend, {
  token: process.env.PI_SERVER_TOKEN!,
  unix: { path: "/tmp/pi/server.sock", mode: 0o600 },
});
await server.start();

console.log(server.unixSocketPath);
```

`unix` is required. `unixSocketPath` is available after `start()` and becomes `undefined` after `close()`.

A runtime implements `snapshot`, `getPhase`, `prompt`, `steer`, `abort`, `setModel`, `setThinking`, `subscribe`, and `dispose`. Runtime methods must reject conflicts with `PiServerError` or `SessionBusyError`; the server never adds a hidden request queue.

`createSession` and `openSession` must acquire an exclusive per-session backend lock. `dispose` releases that lock. `PiServer` keeps one live runtime per session, shares it among attached clients, and unloads it only when it is idle with no attached clients. Disconnecting a client does not abort active work.

## Client

```ts
import { PiClient } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";

const client = new PiClient({
  token,
  transportFactory: createUnixTransportFactory({ path: server.unixSocketPath! }),
});
await client.connect();
```

## Wire protocol

Clients use `@earendil-works/pi-protocol`. Messages are CBOR encoded and prefixed by a four-byte unsigned big-endian payload length. Unix socket reads may fragment frames or contain multiple frames.

Every connection has an independent bounded `ClientMessageDecoder`. The first decoded message must be `hello` with the configured token and protocol version. Duplicate hello messages, malformed CBOR or framing, authentication failures, unsupported versions, and handshake timeouts close only that connection. Requests execute concurrently after a successful handshake, so responses may arrive out of request order.

`maxFrameLength` controls the maximum inbound and outbound CBOR payload. `maxPendingBytes` bounds each connection's ordered write queue; slow consumers are disconnected instead of growing memory without limit.

## Security and lifecycle

Tokens are compared in constant time. Socket mode defaults to `0o600`; authentication remains required because filesystem permissions are not the protocol identity boundary.

The listener rejects paths exceeding the platform's `sockaddr_un` limit, creates missing parent directories, rejects a live listener, removes only a verified stale socket, and never unlinks a regular file. Shutdown removes only the socket inode created by that listener and preserves any path replacement.

To keep Node's automatic pipe cleanup from unlinking a replacement path, the listener binds an owned private socket inode and exposes the configured path as a hard link. Normal shutdown and stale-start recovery clean both owned links after inode verification.

Top-level options include `maxFrameLength`, `maxPendingBytes`, `handshakeTimeoutMs`, `gracefulCloseTimeoutMs`, `serverId`, and `onError`. Timeout values must fit Node's timer range of 1 through 2,147,483,647 milliseconds. Call `await server.close()` for idempotent graceful listener shutdown and runtime disposal.

The current server is same-host Unix only. It does not expose an HTTP health endpoint. Supervisors should use socket readiness plus the protocol handshake. There is no standalone server package CLI and no session close/delete protocol operation.
