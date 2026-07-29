import { DEFAULT_MAX_FRAME_LENGTH } from "@earendil-works/pi-protocol";
import { PiServerCore } from "./core.ts";
import type { PiServerOptions, PiSessionBackend, UnixListenerOptions } from "./types.ts";
import { UnixListener, validateUnixSocketPath } from "./unix-listener.ts";

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS = 5_000;
const MAX_UINT32 = 0xffff_ffff;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface ResolvedOptions {
	unix: UnixListenerOptions;
	maxFrameLength: number;
	maxPendingBytes: number;
	handshakeTimeoutMs: number;
	gracefulCloseTimeoutMs: number;
	onError?: (error: Error) => void;
}

export class PiServer {
	readonly id: string;

	private readonly options: ResolvedOptions;
	private readonly core: PiServerCore;
	private unixListener?: UnixListener;
	private started = false;
	private closing = false;
	private closePromise?: Promise<void>;
	private startPromise?: Promise<this>;

	constructor(backend: PiSessionBackend, options: PiServerOptions) {
		this.options = resolveOptions(options);
		this.core = new PiServerCore(backend, {
			token: options.token,
			maxFrameLength: this.options.maxFrameLength,
			handshakeTimeoutMs: this.options.handshakeTimeoutMs,
			serverId: options.serverId,
			onError: options.onError,
		});
		this.id = this.core.id;
	}

	get unixSocketPath(): string | undefined {
		return this.unixListener?.socketPath;
	}

	start(): Promise<this> {
		if (this.started) return Promise.reject(new Error("PiServer is already started"));
		if (this.startPromise) return Promise.reject(new Error("PiServer is already starting"));
		if (this.closing) return Promise.reject(new Error("PiServer is closing or closed"));
		this.startPromise = this.startInternal();
		return this.startPromise;
	}

	private async startInternal(): Promise<this> {
		const listener = new UnixListener({
			listener: this.options.unix,
			gracefulCloseTimeoutMs: this.options.gracefulCloseTimeoutMs,
			maxPendingBytes: this.options.maxPendingBytes,
			accept: (connection) => this.core.accept(connection),
			onError: this.options.onError,
		});
		this.unixListener = listener;
		try {
			await listener.start();
			this.started = true;
			return this;
		} catch (error) {
			this.closing = true;
			await Promise.all([listener.close(), this.core.close()]);
			throw error;
		} finally {
			this.startPromise = undefined;
		}
	}

	async close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.closePromise = this.closeInternal();
		return this.closePromise;
	}

	private async closeInternal(): Promise<void> {
		const starting = this.startPromise;
		if (starting) await starting.catch(() => {});
		const coreClose = this.core.close();
		try {
			await this.unixListener?.close();
		} finally {
			try {
				await coreClose;
			} finally {
				this.unixListener = undefined;
				this.started = false;
			}
		}
	}
}

function resolveOptions(options: PiServerOptions): ResolvedOptions {
	if (!options.token) throw new TypeError("PiServer token must not be empty");
	if (!options.unix) throw new TypeError("PiServer requires a Unix socket listener");
	if (options.serverId === "") throw new TypeError("PiServer serverId must not be empty");
	const maxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
	if (!Number.isSafeInteger(maxFrameLength) || maxFrameLength <= 0 || maxFrameLength > MAX_UINT32) {
		throw new TypeError(`PiServer maxFrameLength must be an integer between 1 and ${MAX_UINT32}`);
	}
	const maxPendingBytes = options.maxPendingBytes ?? maxFrameLength * 4;
	if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes < maxFrameLength + 4) {
		throw new TypeError("PiServer maxPendingBytes must be a safe integer at least maxFrameLength + 4");
	}
	const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
	if (
		!Number.isSafeInteger(handshakeTimeoutMs) ||
		handshakeTimeoutMs <= 0 ||
		handshakeTimeoutMs > MAX_TIMER_DELAY_MS
	) {
		throw new TypeError(`PiServer handshakeTimeoutMs must be an integer between 1 and ${MAX_TIMER_DELAY_MS}`);
	}
	const gracefulCloseTimeoutMs = options.gracefulCloseTimeoutMs ?? DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS;
	if (
		!Number.isSafeInteger(gracefulCloseTimeoutMs) ||
		gracefulCloseTimeoutMs <= 0 ||
		gracefulCloseTimeoutMs > MAX_TIMER_DELAY_MS
	) {
		throw new TypeError(`PiServer gracefulCloseTimeoutMs must be an integer between 1 and ${MAX_TIMER_DELAY_MS}`);
	}
	validateUnixOptions(options.unix);
	return {
		unix: options.unix,
		maxFrameLength,
		maxPendingBytes,
		handshakeTimeoutMs,
		gracefulCloseTimeoutMs,
		onError: options.onError,
	};
}

function validateUnixOptions(options: UnixListenerOptions): void {
	validateUnixSocketPath(options.path, "PiServer Unix socket path");
	if (options.mode !== undefined && (!Number.isInteger(options.mode) || options.mode < 0 || options.mode > 0o777)) {
		throw new TypeError("PiServer Unix socket mode must be an integer between 0 and 0o777");
	}
}
