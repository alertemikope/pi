import type {
	Command,
	JsonValue,
	ModelMetadata,
	ModelRef,
	ProtocolErrorCode,
	SessionPhase,
	SessionSnapshot,
	SessionSummary,
	ThinkingLevel,
	TranscriptProgress,
} from "@earendil-works/pi-protocol";

export type MaybePromise<T> = T | Promise<T>;

export type PromptInput = Omit<Extract<Command, { command: "prompt" }>, "command" | "sessionId">;
export type SteerInput = Omit<Extract<Command, { command: "steer" }>, "command" | "sessionId">;

export interface CreateSessionOptions {
	/** A collision-resistant ID assigned by PiServer. The backend must persist this exact ID. */
	id: string;
	cwd?: string;
	name?: string;
	model?: ModelRef;
	thinkingLevel?: ThinkingLevel;
}

export type PiSessionRuntimeEvent = { type: "snapshot" } | { type: "progress"; progress: TranscriptProgress };

/**
 * One acquired durable session. Implementations must reject conflicting prompt
 * or mutation calls with PiServerError("busy", ...), rather than queueing them.
 */
export interface PiSessionRuntime {
	snapshot(): MaybePromise<SessionSnapshot>;
	getPhase(): SessionPhase;
	prompt(input: PromptInput): Promise<void>;
	steer(input: SteerInput): Promise<void>;
	abort(): Promise<void>;
	setModel(model: ModelRef): Promise<void>;
	setThinking(thinkingLevel: ThinkingLevel): Promise<void>;
	subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void;
	dispose(): Promise<void>;
}

/**
 * Durable storage and runtime acquisition boundary. createSession and
 * openSession must acquire an exclusive per-session lock that dispose releases.
 */
export interface PiSessionBackend {
	listSessions(): Promise<SessionSummary[]>;
	listModels(): Promise<ModelMetadata[]>;
	createSession(options: CreateSessionOptions): Promise<PiSessionRuntime>;
	openSession(sessionId: string): Promise<PiSessionRuntime>;
}

export type SessionRuntime = PiSessionRuntime;
export type SessionBackend = PiSessionBackend;
export type SessionRuntimeEvent = PiSessionRuntimeEvent;

export type PiServerOperationErrorCode = Extract<
	ProtocolErrorCode,
	"busy" | "session_locked" | "not_found" | "invalid_request"
>;

/** A backend/runtime error that can safely cross the protocol boundary. */
export class PiServerError extends Error {
	readonly code: PiServerOperationErrorCode;
	readonly details: JsonValue | undefined;

	constructor(code: PiServerOperationErrorCode, message: string, details?: JsonValue) {
		super(message);
		this.name = "PiServerError";
		this.code = code;
		this.details = details;
	}
}

export class SessionBusyError extends PiServerError {
	constructor(message = "Session is busy", details?: JsonValue) {
		super("busy", message, details);
		this.name = "SessionBusyError";
	}
}

export class SessionLockedError extends PiServerError {
	constructor(message = "Session is locked", details?: JsonValue) {
		super("session_locked", message, details);
		this.name = "SessionLockedError";
	}
}

export class SessionNotFoundError extends PiServerError {
	constructor(message = "Session was not found", details?: JsonValue) {
		super("not_found", message, details);
		this.name = "SessionNotFoundError";
	}
}

export interface UnixListenerOptions {
	path: string;
	/** Socket filesystem permissions. Defaults to owner read/write only (0o600). */
	mode?: number;
}

export interface PiServerOptions {
	token: string;
	/** Configure the required Unix-domain socket listener. */
	unix: UnixListenerOptions;
	maxFrameLength?: number;
	/** Maximum framed bytes queued per connection before a slow peer is disconnected. */
	maxPendingBytes?: number;
	handshakeTimeoutMs?: number;
	gracefulCloseTimeoutMs?: number;
	serverId?: string;
	onError?: (error: Error) => void;
}
