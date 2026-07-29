import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
	type ClientHello,
	type ClientMessage,
	ClientMessageDecoder,
	type Command,
	type EventEnvelope,
	encodeServerMessage,
	isSupportedProtocolVersion,
	type ModelMetadata,
	PROTOCOL_VERSION,
	type ProtocolError,
	ProtocolValidationError,
	type RequestEnvelope,
	type ResponseEnvelope,
	type ServerHello,
	type ServerHelloError,
	type ServerMessage,
	type ServerSnapshot,
	type SessionSnapshot,
	type SessionSummary,
} from "@earendil-works/pi-protocol";
import type { ByteConnection, ByteConnectionHandler } from "./connection.ts";
import {
	type CreateSessionOptions,
	PiServerError,
	type PiSessionBackend,
	type PiSessionRuntime,
	type PiSessionRuntimeEvent,
} from "./types.ts";

interface CoreOptions {
	token: string;
	maxFrameLength: number;
	handshakeTimeoutMs: number;
	serverId?: string;
	onError?: (error: Error) => void;
}

type ConnectionStage = "awaiting_hello" | "handshaking" | "ready" | "closing" | "closed";

interface ConnectionState {
	id: string;
	connection: ByteConnection;
	decoder: ClientMessageDecoder;
	sessionIds: Set<string>;
	stage: ConnectionStage;
	disconnected: boolean;
	handshakeComplete: boolean;
	handshake?: Promise<void>;
	handshakeTimeout: NodeJS.Timeout;
}

interface LiveSession {
	id: string;
	runtime: PiSessionRuntime;
	connections: Set<ConnectionState>;
	unsubscribe: () => void;
	operationCount: number;
	ready: boolean;
	disposing?: Promise<void>;
}

function tokenDigest(token: string): Buffer {
	return createHash("sha256").update(token, "utf8").digest();
}

function toSummary(snapshot: SessionSnapshot): SessionSummary {
	return {
		id: snapshot.id,
		name: snapshot.name,
		cwd: snapshot.cwd,
		createdAt: snapshot.createdAt,
		updatedAt: snapshot.updatedAt,
		phase: snapshot.phase,
		model: snapshot.model,
		thinkingLevel: snapshot.thinkingLevel,
		attached: snapshot.attached,
		locked: snapshot.locked,
	};
}

function isTerminalConnection(state: ConnectionState): boolean {
	return state.disconnected || state.stage === "closing" || state.stage === "closed";
}

export class PiServerCore {
	readonly id: string;

	private readonly backend: PiSessionBackend;
	private readonly expectedTokenDigest: Buffer;
	private readonly maxFrameLength: number;
	private readonly handshakeTimeoutMs: number;
	private readonly onError: ((error: Error) => void) | undefined;
	private readonly connections = new Set<ConnectionState>();
	private readonly liveSessions = new Map<string, LiveSession>();
	private readonly openingSessions = new Map<string, Promise<LiveSession>>();
	private serverRevision = 0;
	private closing = false;
	private closePromise?: Promise<void>;

	constructor(backend: PiSessionBackend, options: CoreOptions) {
		this.backend = backend;
		this.id = options.serverId ?? randomUUID();
		this.expectedTokenDigest = tokenDigest(options.token);
		this.maxFrameLength = options.maxFrameLength;
		this.handshakeTimeoutMs = options.handshakeTimeoutMs;
		this.onError = options.onError;
	}

	accept(connection: ByteConnection): ByteConnectionHandler {
		if (this.closing) {
			void this.closeConnection(connection);
			return {
				onData: () => {},
				onClose: () => {},
				onError: (error) => this.reportError(error),
			};
		}

		let state: ConnectionState;
		const handshakeTimeout = setTimeout(() => {
			void this.failProtocol(state, {
				code: "invalid_request",
				message: "Handshake timeout",
			});
		}, this.handshakeTimeoutMs);
		handshakeTimeout.unref();
		state = {
			id: randomUUID(),
			connection,
			decoder: new ClientMessageDecoder({ maxFrameLength: this.maxFrameLength }),
			sessionIds: new Set(),
			stage: "awaiting_hello",
			disconnected: false,
			handshakeComplete: false,
			handshakeTimeout,
		};
		this.connections.add(state);

		return {
			onData: (chunk) => this.receive(state, chunk),
			onClose: () => this.transportClosed(state),
			onError: (error) => {
				this.reportError(error);
				void this.closeConnection(connection).then(() => this.disconnect(state));
			},
		};
	}

	async close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.closePromise = this.closeInternal();
		return this.closePromise;
	}

	private receive(state: ConnectionState, chunk: Uint8Array): void {
		if (isTerminalConnection(state)) return;
		let messages: ClientMessage[];
		try {
			messages = state.decoder.push(chunk);
		} catch (error) {
			void this.failProtocol(state, this.toProtocolError(error));
			return;
		}
		for (const message of messages) {
			if (isTerminalConnection(state)) return;
			this.dispatchMessage(state, message);
		}
	}

	private dispatchMessage(state: ConnectionState, message: ClientMessage): void {
		if (state.stage === "awaiting_hello") {
			if (message.type !== "hello") {
				void this.failProtocol(state, {
					code: "invalid_request",
					message: "The first client message must be hello",
				});
				return;
			}
			state.stage = "handshaking";
			state.handshake = this.finishHandshake(state, message).catch((error: unknown) =>
				this.failProtocol(state, this.toProtocolError(error)),
			);
			return;
		}

		if (message.type === "hello") {
			void this.failProtocol(state, {
				code: "invalid_request",
				message: "hello may only be sent as the first message",
			});
			return;
		}

		if (state.stage === "ready") {
			void this.handleRequest(state, message);
			return;
		}
		if (state.stage !== "handshaking") return;
		const handshake = state.handshake;
		if (!handshake) return;
		void handshake.then(() => {
			if (state.stage === "ready" && !state.disconnected) void this.handleRequest(state, message);
		});
	}

	private async finishHandshake(state: ConnectionState, hello: ClientHello): Promise<void> {
		if (!this.authenticate(hello)) {
			await this.failProtocol(state, { code: "auth", message: "Authentication failed" });
			return;
		}
		if (!isSupportedProtocolVersion(hello.version)) {
			await this.failProtocol(state, {
				code: "version",
				message: `Unsupported protocol version ${hello.version}; expected ${PROTOCOL_VERSION}`,
			});
			return;
		}

		const snapshot = await this.getServerSnapshot(undefined, state);
		if (this.closing || state.disconnected || state.stage !== "handshaking" || state.connection.closed) return;
		const sent = await this.sendMessage(state, {
			type: "hello",
			version: PROTOCOL_VERSION,
			connectionId: state.id,
			snapshot,
		} satisfies ServerHello);
		if (sent && !state.disconnected && state.stage === "handshaking") {
			state.handshakeComplete = true;
			state.stage = "ready";
			clearTimeout(state.handshakeTimeout);
			if (snapshot.revision !== this.serverRevision) {
				const current = await this.getServerSnapshot(undefined, state);
				await this.sendMessage(state, {
					type: "event",
					event: { type: "server_snapshot", snapshot: current },
				});
			}
		}
	}

	private authenticate(hello: ClientHello): boolean {
		return timingSafeEqual(tokenDigest(hello.token), this.expectedTokenDigest);
	}

	private async handleRequest(state: ConnectionState, envelope: RequestEnvelope): Promise<void> {
		try {
			const result = await this.executeCommand(state, envelope.request);
			await this.sendMessage(state, {
				type: "response",
				id: envelope.id,
				ok: true,
				result,
			} satisfies ResponseEnvelope);
		} catch (error) {
			await this.sendMessage(state, {
				type: "response",
				id: envelope.id,
				ok: false,
				error: this.toProtocolError(error),
			} satisfies ResponseEnvelope);
		}
	}

	private async executeCommand(state: ConnectionState, command: Command) {
		switch (command.command) {
			case "list":
				return { command: "list" as const, sessions: await this.listSessionSummaries(state) };
			case "create": {
				const id = randomUUID();
				const options: CreateSessionOptions = {
					id,
					cwd: command.cwd,
					name: command.name,
					model: command.model,
					thinkingLevel: command.thinkingLevel,
				};
				const live = await this.acquireSession(id, () => this.backend.createSession(options));
				await this.attach(state, live);
				const session = await this.broadcastSessionSnapshot(live);
				void this.broadcastServerSnapshot();
				return { command: "create" as const, session };
			}
			case "attach": {
				const live = await this.acquireSession(command.sessionId, () =>
					this.backend.openSession(command.sessionId),
				);
				await this.attach(state, live);
				const session = await this.broadcastSessionSnapshot(live);
				void this.broadcastServerSnapshot();
				return { command: "attach" as const, session };
			}
			case "detach": {
				const live = this.requireAttached(state, command.sessionId);
				this.detach(state, live);
				if (live.connections.size > 0) await this.broadcastSessionSnapshot(live);
				await this.maybeDispose(live);
				void this.broadcastServerSnapshot();
				return { command: "detach" as const, sessionId: command.sessionId };
			}
			case "prompt": {
				const live = this.requireAttached(state, command.sessionId);
				const session = await this.runOperation(live, () => live.runtime.prompt({ text: command.text }));
				return { command: "prompt" as const, session };
			}
			case "steer": {
				const live = this.requireAttached(state, command.sessionId);
				const session = await this.runOperation(live, () => live.runtime.steer({ text: command.text }));
				return { command: "steer" as const, session };
			}
			case "abort": {
				const live = this.requireAttached(state, command.sessionId);
				const session = await this.runOperation(live, () => live.runtime.abort());
				return { command: "abort" as const, session };
			}
			case "set_model": {
				const live = this.requireAttached(state, command.sessionId);
				const session = await this.runOperation(live, () => live.runtime.setModel(command.model));
				return { command: "set_model" as const, session };
			}
			case "set_thinking": {
				const live = this.requireAttached(state, command.sessionId);
				const session = await this.runOperation(live, () => live.runtime.setThinking(command.thinkingLevel));
				return { command: "set_thinking" as const, session };
			}
		}
	}

	private async runOperation(live: LiveSession, operation: () => Promise<void>): Promise<SessionSnapshot> {
		live.operationCount += 1;
		try {
			await operation();
			return await this.broadcastSessionSnapshot(live);
		} finally {
			live.operationCount -= 1;
			this.scheduleMaybeDispose(live);
		}
	}

	private async acquireSession(id: string, acquire: () => Promise<PiSessionRuntime>): Promise<LiveSession> {
		for (;;) {
			const existing = this.liveSessions.get(id);
			if (existing) {
				if (existing.disposing) {
					await existing.disposing;
					continue;
				}
				return existing;
			}
			const opening = this.openingSessions.get(id);
			if (opening) return opening;

			const pending = this.createLiveSession(id, acquire);
			this.openingSessions.set(id, pending);
			try {
				return await pending;
			} finally {
				if (this.openingSessions.get(id) === pending) this.openingSessions.delete(id);
			}
		}
	}

	private async createLiveSession(id: string, acquire: () => Promise<PiSessionRuntime>): Promise<LiveSession> {
		const runtime = await acquire();
		if (this.closing) {
			await runtime.dispose();
			throw new Error("PiServer closed while acquiring a session runtime");
		}
		let live: LiveSession | undefined;
		try {
			const snapshot = await runtime.snapshot();
			if (snapshot.id !== id) {
				throw new PiServerError(
					"invalid_request",
					`Backend returned session ${snapshot.id} for server-assigned session ${id}`,
				);
			}
			const createdLive: LiveSession = {
				id,
				runtime,
				connections: new Set(),
				unsubscribe: () => {},
				operationCount: 0,
				ready: false,
			};
			live = createdLive;
			createdLive.unsubscribe = runtime.subscribe((event) => this.handleRuntimeEvent(createdLive, event));
			this.liveSessions.set(id, createdLive);
			createdLive.ready = true;
			return createdLive;
		} catch (error) {
			if (live) live.unsubscribe();
			try {
				await runtime.dispose();
			} catch (disposeError) {
				this.reportError(disposeError);
			}
			throw error;
		}
	}

	private handleRuntimeEvent(live: LiveSession, event: PiSessionRuntimeEvent): void {
		if (event.type === "progress") {
			const envelope: EventEnvelope = {
				type: "event",
				event: { type: "session_progress", sessionId: live.id, progress: event.progress },
			};
			for (const connection of live.connections) void this.sendMessage(connection, envelope);
		} else {
			void this.broadcastSessionSnapshot(live).catch((error: unknown) => this.reportError(error));
		}
		this.scheduleMaybeDispose(live);
	}

	private async normalizedSnapshot(live: LiveSession): Promise<SessionSnapshot> {
		const snapshot = await live.runtime.snapshot();
		if (snapshot.id !== live.id) {
			throw new PiServerError("invalid_request", `Runtime session ID changed from ${live.id} to ${snapshot.id}`);
		}
		return {
			...snapshot,
			phase: live.runtime.getPhase(),
			attached: live.connections.size > 0,
			locked: true,
		};
	}

	private async broadcastSessionSnapshot(live: LiveSession): Promise<SessionSnapshot> {
		const snapshot = await this.normalizedSnapshot(live);
		const envelope: EventEnvelope = { type: "event", event: { type: "session_snapshot", snapshot } };
		for (const connection of live.connections) void this.sendMessage(connection, envelope);
		return snapshot;
	}

	private async attach(connection: ConnectionState, live: LiveSession): Promise<void> {
		if (connection.disconnected || connection.stage !== "ready" || connection.connection.closed) {
			await this.maybeDispose(live);
			throw new PiServerError("invalid_request", "Connection closed while attaching to a session");
		}
		connection.sessionIds.add(live.id);
		live.connections.add(connection);
	}

	private detach(connection: ConnectionState, live: LiveSession): void {
		connection.sessionIds.delete(live.id);
		live.connections.delete(connection);
	}

	private requireAttached(connection: ConnectionState, sessionId: string): LiveSession {
		if (!connection.sessionIds.has(sessionId)) {
			throw new PiServerError("invalid_request", `Connection is not attached to session ${sessionId}`);
		}
		const live = this.liveSessions.get(sessionId);
		if (!live || live.disposing) {
			throw new PiServerError("not_found", `Session is not live: ${sessionId}`);
		}
		return live;
	}

	private transportClosed(connection: ConnectionState): void {
		if (!connection.disconnected && connection.stage !== "closing") {
			try {
				connection.decoder.end();
			} catch (error) {
				this.reportError(error);
			}
		}
		void this.disconnect(connection);
	}

	private async disconnect(connection: ConnectionState): Promise<void> {
		if (connection.disconnected) return;
		const handshakeComplete = connection.handshakeComplete;
		connection.disconnected = true;
		connection.stage = "closed";
		clearTimeout(connection.handshakeTimeout);
		this.connections.delete(connection);
		const sessions = [...connection.sessionIds]
			.map((id) => this.liveSessions.get(id))
			.filter((live): live is LiveSession => live !== undefined);
		connection.sessionIds.clear();
		for (const live of sessions) live.connections.delete(connection);
		const disposalResults = await Promise.allSettled(sessions.map((live) => this.maybeDispose(live)));
		for (const result of disposalResults) {
			if (result.status === "rejected") this.reportError(result.reason);
		}
		if (!this.closing && handshakeComplete) void this.broadcastServerSnapshot();
	}

	private scheduleMaybeDispose(live: LiveSession): void {
		void this.maybeDispose(live).catch((error: unknown) => this.reportError(error));
	}

	private async maybeDispose(live: LiveSession): Promise<void> {
		if (
			this.closing ||
			!live.ready ||
			live.disposing ||
			live.connections.size > 0 ||
			live.operationCount > 0 ||
			live.runtime.getPhase() !== "idle"
		) {
			return live.disposing;
		}
		live.unsubscribe();
		live.disposing = (async () => {
			try {
				await live.runtime.dispose();
			} finally {
				if (this.liveSessions.get(live.id) === live) this.liveSessions.delete(live.id);
			}
		})();
		await live.disposing;
		if (!this.closing) void this.broadcastServerSnapshot();
	}

	private async listSessionSummaries(connection?: ConnectionState): Promise<SessionSummary[]> {
		const stored = await this.backend.listSessions();
		const liveSnapshots = await Promise.all(
			[...this.liveSessions.values()]
				.filter((live) => !live.disposing)
				.map(async (live) => [live.id, await this.normalizedSnapshot(live)] as const),
		);
		const liveById = new Map(liveSnapshots);
		const summaries = stored.map((summary) => {
			const snapshot = liveById.get(summary.id);
			if (!snapshot) return { ...summary, attached: false };
			liveById.delete(summary.id);
			return { ...toSummary(snapshot), attached: connection?.sessionIds.has(summary.id) ?? false };
		});
		for (const snapshot of liveById.values()) {
			summaries.push({ ...toSummary(snapshot), attached: connection?.sessionIds.has(snapshot.id) ?? false });
		}
		return summaries;
	}

	private async getServerSnapshot(models?: ModelMetadata[], connection?: ConnectionState): Promise<ServerSnapshot> {
		return {
			serverId: this.id,
			protocolVersion: PROTOCOL_VERSION,
			revision: this.serverRevision,
			sessions: await this.listSessionSummaries(connection),
			models: models ?? (await this.backend.listModels()),
		};
	}

	private async broadcastServerSnapshot(): Promise<void> {
		const readyConnections = [...this.connections].filter(
			(connection) => connection.stage === "ready" && !connection.disconnected,
		);
		if (readyConnections.length === 0 || this.closing) return;
		try {
			const revision = ++this.serverRevision;
			const models = await this.backend.listModels();
			for (const connection of readyConnections) {
				const current = await this.getServerSnapshot(models, connection);
				const snapshot: ServerSnapshot = { ...current, revision };
				const envelope: EventEnvelope = { type: "event", event: { type: "server_snapshot", snapshot } };
				void this.sendMessage(connection, envelope);
			}
		} catch (error) {
			this.reportError(error);
		}
	}

	private async sendMessage(connection: ConnectionState, message: ServerMessage): Promise<boolean> {
		if (connection.disconnected || connection.connection.closed) return false;
		let frame: Uint8Array;
		try {
			frame = encodeServerMessage(message, { maxFrameLength: this.maxFrameLength });
		} catch (error) {
			this.reportError(error);
			await this.closeConnection(connection.connection);
			await this.disconnect(connection);
			return false;
		}
		try {
			await connection.connection.send(frame);
			return true;
		} catch (error) {
			this.reportError(error);
			await this.closeConnection(connection.connection);
			await this.disconnect(connection);
			return false;
		}
	}

	private async failProtocol(connection: ConnectionState, error: ProtocolError): Promise<void> {
		if (connection.disconnected || connection.stage === "closing" || connection.stage === "closed") return;
		connection.stage = "closing";
		clearTimeout(connection.handshakeTimeout);
		const message: ServerHelloError = { type: "hello_error", error };
		await this.sendMessage(connection, message);
		await this.closeConnection(connection.connection);
		await this.disconnect(connection);
	}

	private async closeInternal(): Promise<void> {
		const connections = [...this.connections];
		for (const connection of connections) {
			connection.stage = "closing";
			clearTimeout(connection.handshakeTimeout);
		}
		await Promise.all(connections.map((connection) => this.closeConnection(connection.connection)));
		await Promise.all(connections.map((connection) => this.disconnect(connection)));

		const openingResults = await Promise.allSettled([...this.openingSessions.values()]);
		for (const result of openingResults) {
			if (result.status === "rejected") this.reportError(result.reason);
		}
		const sessions = [...this.liveSessions.values()];
		this.liveSessions.clear();
		await Promise.all(
			sessions.map(async (live) => {
				if (live.disposing) {
					await live.disposing;
					return;
				}
				live.unsubscribe();
				await live.runtime.dispose();
			}),
		);
		this.connections.clear();
	}

	private async closeConnection(connection: ByteConnection): Promise<void> {
		try {
			await connection.close();
		} catch (error) {
			this.reportError(error);
		}
	}

	private toProtocolError(error: unknown): ProtocolError {
		if (error instanceof PiServerError) {
			return error.details === undefined
				? { code: error.code, message: error.message }
				: { code: error.code, message: error.message, details: error.details };
		}
		if (error instanceof ProtocolValidationError) {
			return { code: "invalid_request", message: error.message };
		}
		this.reportError(error);
		return { code: "invalid_request", message: "Internal server error" };
	}

	private reportError(error: unknown): void {
		try {
			this.onError?.(error instanceof Error ? error : new Error(String(error)));
		} catch {
			// Error observers cannot affect server state.
		}
	}
}
