import type { AssistantMessage } from "../types.ts";

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	// OpenCode Go/free-tier limits returned as 429 JSON error types by OpenCode's
	// Zen API. These are subscription/account limits, not transient throttles.
	"GoUsageLimitError",
	"FreeUsageLimitError",

	// OpenCode Go subscription-limit text asks users to enable available-balance
	// usage after rolling/weekly/monthly limits are reached.
	"Monthly usage limit reached",
	"available balance",

	// Generic quota/budget/billing exhaustion. `insufficient_quota` is OpenAI's
	// quota/billing error code; the other strings cover common gateway wording.
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"billing",
]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	// Generic provider load, HTTP status, and server-side transient failures.
	"overloaded",
	"rate.?limit",
	"too many requests",
	"429",
	"500",
	"502",
	"503",
	"504",
	"524",
	"service.?unavailable",
	"server.?error",
	"internal.?error",

	// Wrapper/provider text for transient upstream failures, including OpenRouter
	// "Provider returned error" responses (#2264).
	"provider.?returned.?error",
	"exceeded request buffer limit while retrying upstream",

	// Network, proxy, and fetch transport failures. This includes OpenAI Codex
	// raw-fetch failures such as "upstream connect", "connection refused", and
	// "reset before headers" (#733), plus OpenRouter connection drops (#3317).
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"other side closed",
	"fetch failed",
	"getaddrinfo",
	"ENOTFOUND",
	"EAI_AGAIN",
	"upstream.?connect",
	"reset before headers",
	"socket hang up",
	"socket connection was closed",
	"timed? out",
	"timeout",
	"terminated",

	// WebSocket transports can report close/error text instead of HTTP/fetch text.
	"websocket.?closed",
	"websocket.?error",

	// Premature stream endings from SDKs and transports. Anthropic can throw
	// "stream ended without ..." and "Anthropic stream ended before message_stop"
	// (#4433); Bedrock/Smithy can throw an HTTP/2 no-response error (#3594).
	"ended without",
	"stream ended before message_stop",
	"stream ended before a terminal response event",
	"http2 request did not get a response",

	// Provider-requested retry delay cap failures should flow through the outer
	// retry policy so callers can surface/abort the backoff (#1123).
	"retry delay",

	// Explicit retry guidance emitted mid-stream by OpenAI Responses and Bedrock
	// stream exceptions (#6019).
	"you can retry your request",
	"try your request again",
	"please retry your request",

	// gRPC based providers (e.g. NVIDIA NIM)
	"ResourceExhausted",
]);

const AUTH_ERROR_PATTERN = buildProviderErrorPattern([
	"401",
	"unauthorized",
	"invalid.?api.?key",
	"authentication.?failed",
	"invalid.?token",
	"token.?expired",
]);
const PERMISSION_ERROR_PATTERN = buildProviderErrorPattern(["403", "forbidden", "permission.?denied"]);
const CONTEXT_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	"context.?length",
	"context.?window",
	"maximum.?context",
	"too many tokens",
	"max_tokens",
]);
const NETWORK_ERROR_PATTERN = buildProviderErrorPattern([
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"other side closed",
	"fetch failed",
	"getaddrinfo",
	"ENOTFOUND",
	"EAI_AGAIN",
	"upstream.?connect",
	"reset before headers",
	"socket hang up",
	"socket connection was closed",
	"timed? out",
	"timeout",
	"terminated",
	"websocket.?closed",
	"websocket.?error",
	"ended without",
	"stream ended before",
	"http2 request did not get a response",
]);
const RATE_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	"rate.?limit",
	"too many requests",
	"429",
	"ResourceExhausted",
]);
const CAPACITY_ERROR_PATTERN = buildProviderErrorPattern([
	"overloaded",
	"500",
	"502",
	"503",
	"504",
	"524",
	"service.?unavailable",
	"server.?error",
	"internal.?error",
	"provider.?returned.?error",
]);
const INVALID_INPUT_ERROR_PATTERN = buildProviderErrorPattern(["400", "bad.?request", "invalid.?request"]);

export type FailureKind =
	| "auth"
	| "rate_limit"
	| "capacity"
	| "network"
	| "quota"
	| "invalid_input"
	| "context_limit"
	| "permission"
	| "cancelled"
	| "unknown";

export type FailureRecoveryAction =
	| "retry"
	| "wait"
	| "reauthenticate"
	| "compact"
	| "change_model"
	| "fix_input"
	| "abort";

export interface FailureDisposition {
	kind: FailureKind;
	retryable: boolean;
	retryAfterMs?: number;
	recovery: { action: FailureRecoveryAction; hint?: string };
}

function diagnosticNumber(message: AssistantMessage, key: string): number | undefined {
	for (const diagnostic of message.diagnostics ?? []) {
		const value = diagnostic.details?.[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

function failureText(message: AssistantMessage): string {
	return [
		message.errorMessage,
		message.rawStopReason,
		...(message.diagnostics ?? []).flatMap((diagnostic) => [
			diagnostic.error?.message,
			diagnostic.error?.code === undefined ? undefined : String(diagnostic.error.code),
		]),
	]
		.filter((value): value is string => typeof value === "string" && value.length > 0)
		.join("\n");
}

/** Pure recovery classification for an assistant failure. */
export function classifyAssistantFailure(message: AssistantMessage): FailureDisposition {
	if (message.stopReason === "aborted") {
		return { kind: "cancelled", retryable: false, recovery: { action: "abort" } };
	}
	const text = failureText(message);
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(text)) {
		return {
			kind: "quota",
			retryable: false,
			recovery: { action: "abort", hint: "Check provider quota or billing before retrying." },
		};
	}
	if (AUTH_ERROR_PATTERN.test(text)) {
		return { kind: "auth", retryable: false, recovery: { action: "reauthenticate" } };
	}
	if (PERMISSION_ERROR_PATTERN.test(text)) {
		return { kind: "permission", retryable: false, recovery: { action: "abort" } };
	}
	if (CONTEXT_LIMIT_ERROR_PATTERN.test(text)) {
		return { kind: "context_limit", retryable: false, recovery: { action: "compact" } };
	}
	if (RATE_LIMIT_ERROR_PATTERN.test(text)) {
		const retryAfterMs = diagnosticNumber(message, "retryAfterMs");
		return {
			kind: "rate_limit",
			retryable: true,
			...(retryAfterMs === undefined ? {} : { retryAfterMs }),
			recovery: { action: "wait" },
		};
	}
	if (NETWORK_ERROR_PATTERN.test(text)) {
		return { kind: "network", retryable: true, recovery: { action: "retry" } };
	}
	if (CAPACITY_ERROR_PATTERN.test(text)) {
		return { kind: "capacity", retryable: true, recovery: { action: "change_model" } };
	}
	if (INVALID_INPUT_ERROR_PATTERN.test(text)) {
		return { kind: "invalid_input", retryable: false, recovery: { action: "fix_input" } };
	}
	const retryable = message.stopReason === "error" && RETRYABLE_PROVIDER_ERROR_PATTERN.test(text);
	return {
		kind: "unknown",
		retryable,
		recovery: { action: retryable ? "retry" : "abort" },
	};
}

/**
 * Retry policy: bounded attempts with exponential backoff (`baseDelayMs * 2^(attempt-1)`).
 * Matches `settings.retry` (`enabled`, `maxRetries`, `baseDelayMs`) in coding-agent; kept
 * here so the classifier and the policy-driven retry loop live together and stay reusable
 * by the SDK and other callers.
 */
export interface RetryPolicy {
	enabled: boolean;
	/** Max retry attempts (0 = no retries). The initial call never counts as a retry. */
	maxRetries: number;
	/** Base delay in ms. Per-attempt delay is `baseDelayMs * 2^(attempt-1)` before jitter. */
	baseDelayMs: number;
}

/** Optional callbacks emitted by {@link retryAssistantCall} around each retry. */
export interface RetryCallbacks {
	/** Emitted before the backoff sleep of each retry attempt (1-indexed). */
	onRetryScheduled?: (
		attempt: number,
		maxAttempts: number,
		delayMs: number,
		errorMessage: string,
	) => void | Promise<void>;
	/** Emitted after the backoff sleep, immediately before the retried call starts. */
	onRetryAttemptStart?: () => void | Promise<void>;
	/** Emitted once when the loop ends: success if a later call completed normally. */
	onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => void | Promise<void>;
}

class RetrySleepAbortError extends Error {
	constructor() {
		super("Aborted");
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new RetrySleepAbortError());
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new RetrySleepAbortError());
			},
			{ once: true },
		);
	});
}

/**
 * Run a single assistant-producing call with bounded retry on transient errors.
 *
 * Behavior:
 * - A successful response is returned immediately. Aborts are terminal and never
 *   retried, but reported as unsuccessful if they happen after a retry was scheduled.
 *   Aborts during the backoff sleep are normalized to an aborted `AssistantMessage`
 *   too, so callers do not need to care when cancellation happened.
 * - A non-retryable error (per {@link isRetryableAssistantError}, including quota/
 *   billing exhaustion) is returned immediately so deterministic errors fail fast.
 * - Otherwise retries up to `maxRetries` times with exponential backoff, emitting
 *   `onRetryScheduled` before each sleep, `onRetryAttemptStart` after each sleep before
 *   the retried call starts, and `onRetryFinished` once at the end (whether the loop
 *   ends in success, exhausted retries, or an aborted backoff).
 *
 * When `policy` is undefined or disabled, the first response is returned unchanged
 * (equivalent to calling `produce()` directly).
 */
export async function retryAssistantCall(
	produce: () => Promise<AssistantMessage>,
	policy: RetryPolicy | undefined,
	signal: AbortSignal | undefined,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	const maxAttempts = policy?.enabled ? policy.maxRetries : 0;

	let attempt = 0;
	let lastRetry: { attempt: number; errorMessage: string } | undefined;
	for (;;) {
		const response = await produce();

		// Abort: terminal but not successful. Never retry an aborted message.
		if (response.stopReason === "aborted") {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt);
			return response;
		}

		// Success: non-error, non-abort responses return as-is.
		if (response.stopReason !== "error") {
			if (lastRetry) await callbacks?.onRetryFinished?.(true, lastRetry.attempt);
			return response;
		}

		// Non-retryable, or budget exhausted: return the final error message.
		if (attempt >= maxAttempts || !isRetryableAssistantError(response)) {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);
			return response;
		}

		attempt++;
		lastRetry = { attempt, errorMessage: response.errorMessage || "Unknown error" };
		const delayMs = policy!.baseDelayMs * 2 ** (attempt - 1);
		await callbacks?.onRetryScheduled?.(attempt, maxAttempts, delayMs, lastRetry.errorMessage);

		// Normalize aborts during retry backoff to the same AssistantMessage shape as
		// provider stream aborts, so callers do not need to care when cancellation happened.
		try {
			await sleep(delayMs, signal);
		} catch (error) {
			await callbacks?.onRetryFinished?.(false, attempt, lastRetry.errorMessage);
			if (error instanceof RetrySleepAbortError) {
				return { ...response, stopReason: "aborted", errorMessage: undefined };
			}
			throw error;
		}
		await callbacks?.onRetryAttemptStart?.();
	}
}

/**
 * Classifies whether a failed assistant message looks like a transient provider
 * or transport error, so callers can decide if the last assistant turn should be
 * restarted.
 *
 * This does not implement retry policy. Callers should first handle context
 * overflow separately, then apply their own retry budget, backoff, and reporting
 * before restarting the assistant turn.
 */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error") return false;
	return classifyAssistantFailure(message).retryable;
}
