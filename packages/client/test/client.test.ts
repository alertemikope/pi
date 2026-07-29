import {
	type ClientMessage,
	ClientMessageDecoder,
	encodeCbor,
	encodeFrame,
	encodeServerMessage,
	PROTOCOL_VERSION,
	ProtocolValidationError,
	type RequestEnvelope,
	type ServerMessage,
	type ServerSnapshot,
	type SessionSnapshot,
} from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import {
	type ByteTransport,
	type ByteTransportFactory,
	type ByteTransportHandlers,
	PiClient,
	PiDisconnectedError,
	PiError,
	PiSessionDetachedError,
} from "../src/index.ts";

class MemoryByteServer {
	private handlers: ByteTransportHandlers | undefined;
	private readonly decoder = new ClientMessageDecoder();
	private readonly messageListeners = new Set<(message: ClientMessage) => void>();
	public readonly sentByClient: Uint8Array[] = [];
	public clientCloseCount = 0;

	connect(handlers: ByteTransportHandlers): ByteTransport {
		this.handlers = handlers;
		let closed = false;
		return {
			send: async (chunk) => {
				if (closed) throw new Error("Transport is closed");
				this.sentByClient.push(chunk.slice());
				for (const message of this.decoder.push(chunk)) {
					for (const listener of this.messageListeners) listener(message);
				}
			},
			close: () => {
				if (closed) return;
				closed = true;
				this.clientCloseCount++;
			},
		};
	}

	onMessage(listener: (message: ClientMessage) => void): () => void {
		this.messageListeners.add(listener);
		return () => this.messageListeners.delete(listener);
	}

	send(message: ServerMessage, splitAt?: number): void {
		const frame = encodeServerMessage(message);
		if (splitAt === undefined) {
			this.sendRaw(frame);
			return;
		}
		this.sendRaw(frame.subarray(0, splitAt));
		this.sendRaw(frame.subarray(splitAt));
	}

	sendTogether(messages: ServerMessage[]): void {
		const frames = messages.map((message) => encodeServerMessage(message));
		const length = frames.reduce((total, frame) => total + frame.byteLength, 0);
		const chunk = new Uint8Array(length);
		let offset = 0;
		for (const frame of frames) {
			chunk.set(frame, offset);
			offset += frame.byteLength;
		}
		this.sendRaw(chunk);
	}

	sendRaw(chunk: Uint8Array): void {
		this.handlers?.onData(chunk);
	}

	close(): void {
		this.handlers?.onClose();
	}

	error(error: Error): void {
		this.handlers?.onError(error);
	}
}

const baseServerSnapshot: ServerSnapshot = {
	serverId: "server-1",
	protocolVersion: PROTOCOL_VERSION,
	revision: 1,
	sessions: [],
	models: [],
};

function sessionSnapshot(id: string, overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
	return {
		id,
		cwd: "/workspace",
		createdAt: 1,
		updatedAt: 1,
		phase: "idle",
		model: { provider: "faux", id: "model" },
		thinkingLevel: "off",
		attached: true,
		locked: true,
		revision: 1,
		transcript: [],
		queuedSteer: [],
		queuedSteerCount: 0,
		...overrides,
	};
}

function createClient(server: MemoryByteServer, token = "bearer-secret"): PiClient {
	return new PiClient({
		token,
		transportFactory: (handlers) => server.connect(handlers),
	});
}

async function connectClient(server: MemoryByteServer, token = "bearer-secret"): Promise<PiClient> {
	const client = createClient(server, token);
	server.onMessage((message) => {
		if (message.type === "hello") {
			server.send({
				type: "hello",
				version: PROTOCOL_VERSION,
				connectionId: "connection-1",
				snapshot: baseServerSnapshot,
			});
		}
	});
	await client.connect();
	return client;
}

function collectRequests(server: MemoryByteServer): RequestEnvelope[] {
	const requests: RequestEnvelope[] = [];
	server.onMessage((message) => {
		if (message.type === "request") requests.push(message);
	});
	return requests;
}

describe("PiClient", () => {
	test("sends a framed version and bearer token before accepting a fragmented server hello", async () => {
		const server = new MemoryByteServer();
		const received: ClientMessage[] = [];
		server.onMessage((message) => {
			received.push(message);
			if (message.type === "hello") {
				server.send(
					{
						type: "hello",
						version: PROTOCOL_VERSION,
						connectionId: "connection-1",
						snapshot: baseServerSnapshot,
					},
					3,
				);
			}
		});
		const client = createClient(server);

		await expect(client.connect()).resolves.toEqual(baseServerSnapshot);
		expect(received[0]).toEqual({ type: "hello", version: PROTOCOL_VERSION, token: "bearer-secret" });
		expect(server.sentByClient[0]).toBeInstanceOf(Uint8Array);
		expect(client.connectionState).toBe("connected");
	});

	test("isolates subscriber failures from handshake and transport state", async () => {
		const server = new MemoryByteServer();
		server.onMessage((message) => {
			if (message.type === "hello") {
				server.send({
					type: "hello",
					version: PROTOCOL_VERSION,
					connectionId: "connection-1",
					snapshot: baseServerSnapshot,
				});
			}
		});
		const client = createClient(server);
		client.subscribe(() => {
			throw new Error("consumer failure");
		});

		await expect(client.connect()).resolves.toEqual(baseServerSnapshot);
		expect(client.connectionState).toBe("connected");
	});

	test("rejects a typed handshake authentication error", async () => {
		const server = new MemoryByteServer();
		server.onMessage(() => {
			server.send({
				type: "hello_error",
				error: { code: "auth", message: "Invalid token" },
			});
		});
		const client = createClient(server, "wrong");

		await expect(client.connect()).rejects.toMatchObject({
			name: "PiError",
			code: "auth",
			message: "Invalid token",
		});
		expect(client.connectionState).toBe("disconnected");
		expect(server.clientCloseCount).toBe(1);
	});

	test("correlates coalesced out-of-order responses", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const requests = collectRequests(server);
		const listed = client.listSessions();
		const attached = client.attachSession("session-1");
		expect(requests).toHaveLength(2);

		const attachRequest = requests.find((request) => request.request.command === "attach");
		const listRequest = requests.find((request) => request.request.command === "list");
		if (!attachRequest || !listRequest) throw new Error("Missing requests");
		server.sendTogether([
			{
				type: "response",
				id: attachRequest.id,
				ok: true,
				result: { command: "attach", session: sessionSnapshot("session-1") },
			},
			{
				type: "response",
				id: listRequest.id,
				ok: true,
				result: { command: "list", sessions: [] },
			},
		]);

		await expect(listed).resolves.toEqual([]);
		await expect(attached).resolves.toMatchObject({ id: "session-1", attached: true });
	});

	test("reduces only authoritative snapshots and supports unsubscribe", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const requests = collectRequests(server);
		const initial = sessionSnapshot("session-1", { revision: 1, phase: "idle" });
		server.send({ type: "event", event: { type: "session_snapshot", snapshot: initial } });
		const handle = client.getSession("session-1");
		const observed: number[] = [];
		const progressTypes: string[] = [];
		const unsubscribe = handle.subscribe((snapshot) => observed.push(snapshot.revision));
		const unsubscribeEvents = handle.onEvent((event) => progressTypes.push(event.type));
		server.send({
			type: "event",
			event: {
				type: "session_progress",
				sessionId: "session-1",
				progress: {
					type: "assistant_delta",
					messageId: "assistant-1",
					contentIndex: 0,
					kind: "text",
					delta: "hi",
				},
			},
		});
		expect(progressTypes).toEqual(["session_progress"]);
		expect(handle.snapshot).toEqual(initial);

		const prompting = handle.prompt("hello");
		expect(handle.snapshot).toEqual(initial);
		const promptRequest = requests.find((request) => request.request.command === "prompt");
		if (!promptRequest) throw new Error("Missing prompt request");
		const updated = sessionSnapshot("session-1", { revision: 2, phase: "turn" });
		server.send({
			type: "response",
			id: promptRequest.id,
			ok: true,
			result: { command: "prompt", session: updated },
		});
		await expect(prompting).resolves.toEqual(updated);
		expect(handle.snapshot).toEqual(updated);
		expect(observed).toEqual([2]);

		unsubscribe();
		unsubscribeEvents();
		server.send({
			type: "event",
			event: { type: "session_snapshot", snapshot: sessionSnapshot("session-1", { revision: 3 }) },
		});
		expect(observed).toEqual([2]);
	});

	test("keeps multiple session handles independent and enforces detach", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		server.onMessage((message) => {
			if (message.type !== "request") return;
			const request = message.request;
			if (request.command === "attach") {
				server.send({
					type: "response",
					id: message.id,
					ok: true,
					result: { command: "attach", session: sessionSnapshot(request.sessionId) },
				});
			}
			if (request.command === "detach") {
				server.send({
					type: "response",
					id: message.id,
					ok: true,
					result: { command: "detach", sessionId: request.sessionId },
				});
			}
		});

		const first = await client.attachSession("session-1");
		const second = await client.attachSession("session-2");
		expect(first.attached).toBe(true);
		expect(second.attached).toBe(true);
		await first.detach();
		expect(first.attached).toBe(false);
		expect(second.attached).toBe(true);
		await expect(first.abort()).rejects.toBeInstanceOf(PiSessionDetachedError);
	});

	test("rejects pending requests on close and reconnects through a fresh factory result", async () => {
		const first = new MemoryByteServer();
		const second = new MemoryByteServer();
		let connection = 0;
		for (const server of [first, second]) {
			server.onMessage((message) => {
				if (message.type === "hello") {
					server.send({
						type: "hello",
						version: PROTOCOL_VERSION,
						connectionId: `connection-${connection}`,
						snapshot: { ...baseServerSnapshot, revision: connection },
					});
				}
			});
		}
		const transportFactory: ByteTransportFactory = (handlers) =>
			(connection++ === 0 ? first : second).connect(handlers);
		const client = new PiClient({ token: "bearer-secret", transportFactory });
		const states: string[] = [];
		client.onConnectionStateChange(({ state }) => states.push(state));
		await client.connect();
		const pending = client.listSessions();
		first.close();
		await expect(pending).rejects.toBeInstanceOf(PiDisconnectedError);
		expect(client.connectionState).toBe("disconnected");

		await expect(client.reconnect()).resolves.toMatchObject({ revision: 2 });
		expect(client.connectionState).toBe("connected");
		expect(states).toEqual(["connecting", "connected", "disconnected", "connecting", "connected"]);
	});

	test("rejects pending requests on transport errors", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const pending = client.listSessions();
		server.error(new Error("read failed"));

		await expect(pending).rejects.toMatchObject({ name: "PiDisconnectedError", message: "read failed" });
		expect(client.connectionState).toBe("disconnected");
	});

	test("enforces the configured frame limit for outbound and inbound messages", async () => {
		const server = new MemoryByteServer();
		server.onMessage((message) => {
			if (message.type === "hello") {
				server.send({
					type: "hello",
					version: PROTOCOL_VERSION,
					connectionId: "connection-1",
					snapshot: baseServerSnapshot,
				});
			}
		});
		const client = new PiClient({
			token: "bearer-secret",
			maxFrameLength: 512,
			transportFactory: (handlers) => server.connect(handlers),
		});
		await client.connect();
		const sentBefore = server.sentByClient.length;
		await expect(
			client.request({ command: "prompt", sessionId: "session-1", text: "x".repeat(1_000) }),
		).rejects.toBeInstanceOf(ProtocolValidationError);
		expect(server.sentByClient).toHaveLength(sentBefore);

		server.sendRaw(new Uint8Array([0, 0, 2, 1]));
		expect(client.connectionState).toBe("disconnected");
	});

	test("disconnects on invalid protocol data", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		server.sendRaw(encodeFrame(encodeCbor({ type: "event", event: { type: "session_removed", sessionId: 1 } })));
		expect(client.connectionState).toBe("disconnected");
	});

	test("reports truncated framing when the transport closes", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		server.sendRaw(new Uint8Array([0, 0, 0, 2, 1]));
		server.close();

		expect(client.connectionState).toBe("disconnected");
		await expect(client.listSessions()).rejects.toBeInstanceOf(PiDisconnectedError);
	});

	test("rejects a mismatched response instead of leaving its request pending", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const requests = collectRequests(server);
		const listed = client.listSessions();
		server.send({
			type: "response",
			id: requests[0]?.id ?? "missing",
			ok: true,
			result: { command: "attach", session: sessionSnapshot("session-1") },
		});

		await expect(listed).rejects.toBeInstanceOf(ProtocolValidationError);
		expect(client.connectionState).toBe("disconnected");
	});

	test("does not let a delayed command response replace a newer event snapshot", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const initial = sessionSnapshot("session-1", { revision: 1, thinkingLevel: "off" });
		server.send({ type: "event", event: { type: "session_snapshot", snapshot: initial } });
		const handle = client.getSession("session-1");
		const requests = collectRequests(server);
		const changing = handle.setThinking("high");
		const request = requests.find((candidate) => candidate.request.command === "set_thinking");
		if (!request) throw new Error("Missing set_thinking request");
		server.send({
			type: "event",
			event: {
				type: "session_snapshot",
				snapshot: sessionSnapshot("session-1", { revision: 3, thinkingLevel: "high" }),
			},
		});
		server.send({
			type: "response",
			id: request.id,
			ok: true,
			result: {
				command: "set_thinking",
				session: sessionSnapshot("session-1", { revision: 2, thinkingLevel: "medium" }),
			},
		});

		await changing;
		expect(handle.snapshot).toMatchObject({ revision: 3, thinkingLevel: "high" });
	});

	test("does not let an attach response replace a newer snapshot from the reacquired runtime", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		server.send({
			type: "event",
			event: {
				type: "session_snapshot",
				snapshot: sessionSnapshot("session-1", { revision: 10, attached: false }),
			},
		});
		server.onMessage((message) => {
			if (message.type !== "request" || message.request.command !== "attach") return;
			server.send({
				type: "event",
				event: {
					type: "session_snapshot",
					snapshot: sessionSnapshot("session-1", { revision: 3, thinkingLevel: "high" }),
				},
			});
			server.send({
				type: "response",
				id: message.id,
				ok: true,
				result: {
					command: "attach",
					session: sessionSnapshot("session-1", { revision: 2, thinkingLevel: "medium" }),
				},
			});
		});

		const handle = await client.attachSession("session-1");
		expect(handle.snapshot).toMatchObject({ revision: 3, thinkingLevel: "high" });
	});

	test("accepts a lower revision after detaching and reacquiring the same session", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		let attachCount = 0;
		server.onMessage((message) => {
			if (message.type !== "request") return;
			if (message.request.command === "attach") {
				server.send({
					type: "response",
					id: message.id,
					ok: true,
					result: {
						command: "attach",
						session: sessionSnapshot("session-1", { revision: attachCount++ === 0 ? 10 : 0 }),
					},
				});
			}
			if (message.request.command === "detach") {
				server.send({
					type: "response",
					id: message.id,
					ok: true,
					result: { command: "detach", sessionId: "session-1" },
				});
			}
		});

		const first = await client.attachSession("session-1");
		expect(first.snapshot?.revision).toBe(10);
		await first.detach();
		const reopened = await client.attachSession("session-1");
		expect(reopened.snapshot?.revision).toBe(0);
	});

	test("rejects frame limits outside the unsigned 32-bit range", () => {
		const server = new MemoryByteServer();
		expect(
			() =>
				new PiClient({
					token: "secret",
					maxFrameLength: 0x1_0000_0000,
					transportFactory: (handlers) => server.connect(handlers),
				}),
		).toThrow(/maxFrameLength/);
	});

	test("surfaces typed request errors", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const requests = collectRequests(server);
		const attaching = client.attachSession("locked");
		server.send({
			type: "response",
			id: requests[0]?.id ?? "missing",
			ok: false,
			error: { code: "session_locked", message: "Already attached" },
		});
		await expect(attaching).rejects.toBeInstanceOf(PiError);
		await expect(attaching).rejects.toMatchObject({ code: "session_locked" });
	});
});
