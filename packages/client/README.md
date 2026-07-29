# @earendil-works/pi-client

Transport-neutral client for remote pi sessions. `PiClient` exchanges length-prefixed CBOR messages through a small `ByteTransport` interface. The root package has no Node imports.

The only bundled transport is currently the Node Unix-domain socket adapter. Additional transports are deferred while the protocol and client/server architecture stabilize.

## Unix-domain socket

The Node-only adapter is available from the `unix` subpath so the package root remains runtime-neutral.

```ts
import { PiClient } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";

const maxFrameLength = 1024 * 1024;
const client = new PiClient({
  token: bearerToken,
  maxFrameLength,
  transportFactory: createUnixTransportFactory({
    path: "/tmp/pi.sock",
    maxPendingBytes: maxFrameLength * 4,
  }),
});

await client.connect();
const session = await client.createSession({ cwd: "/workspace" });
const unsubscribe = session.subscribe((snapshot) => render(snapshot));
await session.prompt("Inspect this project");
unsubscribe();
```

Unix writes are ordered and await stream backpressure. Incoming socket data is passed through as arbitrary byte chunks. `PiClient` owns protocol framing and incremental decoding. Paths exceeding the platform's `sockaddr_un` limit are rejected before connecting.

## Custom transports

```ts
import type {
  ByteTransport,
  ByteTransportFactory,
  ByteTransportHandlers,
} from "@earendil-works/pi-client";

const transportFactory: ByteTransportFactory = async (
  handlers: ByteTransportHandlers,
): Promise<ByteTransport> => {
  // Create a fresh connected transport for this connection attempt.
  return {
    async send(chunk: Uint8Array) {
      // Preserve invocation order and resolve after accepting backpressure.
    },
    close() {},
  };
};
```

Call `handlers.onData(chunk)` for inbound bytes, `handlers.onClose()` for an orderly remote close, and `handlers.onError(error)` for transport failures.

`PiClient` does not reconnect automatically. Call `reconnect()` after a disconnect. The configured factory is invoked again and must create a fresh transport. One connection can attach several `PiSessionClient` handles. Requests are correlated by ID. Server snapshots and successful response snapshots are authoritative, while progress events never mutate snapshot state optimistically.

`subscribe` observes authoritative snapshots. `onEvent` observes protocol events and returns an unsubscribe function. A detached handle remains usable for inspection, but domain commands throw `PiSessionDetachedError` until the session is attached again.

## Wire format, limits, and security

The Unix adapter carries `[4-byte unsigned big-endian CBOR payload length][CBOR payload]`. Socket reads may split a frame or contain several frames.

`PiClientOptions.maxFrameLength` bounds inbound and outbound CBOR payloads. `UnixTransportOptions.maxPendingBytes` bounds queued outbound bytes so a slow peer cannot grow memory without limit. Configure matching frame limits on the client and server.

Treat local peers as untrusted despite filesystem locality. Require the protocol bearer token and use restrictive socket and parent-directory permissions.
