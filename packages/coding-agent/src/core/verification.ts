import { createHash, randomUUID } from "node:crypto";
import { execCommand, type ProcessTermination } from "./exec.ts";

const DEFAULT_OUTPUT_LIMIT = 16 * 1024;

export interface VerificationCheck {
	id: string;
	command: string;
	args: string[];
	cwd?: string;
	timeoutMs?: number;
	outputLimitBytes?: number;
}

export interface VerificationOutputEvidence {
	sha256: string;
	bytes: number;
	excerpt: string;
	truncated: boolean;
}

export interface VerificationReceipt {
	id: string;
	criterionId: string;
	sessionId: string;
	operationId: string;
	cwd: string;
	argv: string[];
	startedAt: number;
	finishedAt: number;
	termination: ProcessTermination;
	verdict: "passed" | "failed";
	stdout: VerificationOutputEvidence;
	stderr: VerificationOutputEvidence;
}

function outputEvidence(value: string, limitBytes: number): VerificationOutputEvidence {
	const bytes = Buffer.from(value);
	return {
		sha256: createHash("sha256").update(bytes).digest("hex"),
		bytes: bytes.length,
		excerpt: bytes.subarray(0, limitBytes).toString("utf8"),
		truncated: bytes.length > limitBytes,
	};
}

function isProcessTermination(value: unknown): value is ProcessTermination {
	if (!value || typeof value !== "object" || !("kind" in value)) return false;
	const termination = value as Record<string, unknown>;
	switch (termination.kind) {
		case "exited":
			return typeof termination.code === "number" && Number.isInteger(termination.code);
		case "signaled":
			return termination.signal === null || typeof termination.signal === "string";
		case "aborted":
			return true;
		case "timed_out":
			return typeof termination.timeoutMs === "number" && termination.timeoutMs > 0;
		case "spawn_error":
			return typeof termination.message === "string";
		default:
			return false;
	}
}

function isOutputEvidence(value: unknown): value is VerificationOutputEvidence {
	if (!value || typeof value !== "object") return false;
	const evidence = value as Record<string, unknown>;
	return (
		typeof evidence.sha256 === "string" &&
		/^[a-f0-9]{64}$/.test(evidence.sha256) &&
		typeof evidence.bytes === "number" &&
		Number.isInteger(evidence.bytes) &&
		evidence.bytes >= 0 &&
		typeof evidence.excerpt === "string" &&
		typeof evidence.truncated === "boolean"
	);
}

export function isVerificationReceipt(value: unknown): value is VerificationReceipt {
	if (!value || typeof value !== "object") return false;
	const receipt = value as Record<string, unknown>;
	return (
		typeof receipt.id === "string" &&
		receipt.id.length > 0 &&
		typeof receipt.criterionId === "string" &&
		receipt.criterionId.length > 0 &&
		typeof receipt.sessionId === "string" &&
		receipt.sessionId.length > 0 &&
		typeof receipt.operationId === "string" &&
		receipt.operationId.length > 0 &&
		typeof receipt.cwd === "string" &&
		Array.isArray(receipt.argv) &&
		receipt.argv.every((part) => typeof part === "string") &&
		typeof receipt.startedAt === "number" &&
		Number.isFinite(receipt.startedAt) &&
		typeof receipt.finishedAt === "number" &&
		Number.isFinite(receipt.finishedAt) &&
		receipt.finishedAt >= receipt.startedAt &&
		(receipt.verdict === "passed" || receipt.verdict === "failed") &&
		isProcessTermination(receipt.termination) &&
		isOutputEvidence(receipt.stdout) &&
		isOutputEvidence(receipt.stderr)
	);
}

export async function runHostVerification(
	context: { sessionId: string; operationId: string; cwd: string; signal?: AbortSignal },
	check: VerificationCheck,
): Promise<VerificationReceipt> {
	if (!check.id.trim()) throw new Error("Verification criterion id must not be empty.");
	if (!check.command.trim()) throw new Error(`Verification command for ${check.id} must not be empty.`);
	const outputLimitBytes = check.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT;
	if (!Number.isInteger(outputLimitBytes) || outputLimitBytes <= 0) {
		throw new Error(`Verification output limit for ${check.id} must be a positive integer.`);
	}
	const cwd = check.cwd ?? context.cwd;
	const startedAt = Date.now();
	const result = await execCommand(check.command, check.args, cwd, {
		signal: context.signal,
		timeout: check.timeoutMs,
	});
	const finishedAt = Date.now();
	return {
		id: randomUUID(),
		criterionId: check.id,
		sessionId: context.sessionId,
		operationId: context.operationId,
		cwd,
		argv: [check.command, ...check.args],
		startedAt,
		finishedAt,
		termination: result.termination,
		verdict: result.termination.kind === "exited" && result.termination.code === 0 ? "passed" : "failed",
		stdout: outputEvidence(result.stdout, outputLimitBytes),
		stderr: outputEvidence(result.stderr, outputLimitBytes),
	};
}
