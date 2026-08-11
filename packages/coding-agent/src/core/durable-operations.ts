import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	statSync,
	truncateSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	type ContentAddressedBlobRef,
	ContentAddressedStore,
	isContentAddressedBlobRef,
} from "./content-addressed-store.ts";
import { isVerificationReceipt, type VerificationReceipt } from "./verification.ts";

export type DurableOperationStatus = "accepted" | "running" | "suspended" | "completed" | "failed" | "aborted";
export type DurableOperationOutcome = Extract<DurableOperationStatus, "completed" | "failed" | "aborted">;
export type DurableOperationKind = "run" | "compaction" | "navigation";
export type DurableReplayPolicy = "safe" | "never";
export type DurableEffectStatus = "reserved" | "dispatched" | "completed" | "failed" | "unresolved";
export const DEFAULT_DURABLE_OPERATION_LANE = "main";

export type ProviderPayloadInvalidationReason =
	| "first_request"
	| "none"
	| "provider_changed"
	| "model_changed"
	| "api_changed"
	| "payload_shrank"
	| "prefix_changed";

export interface ProviderPayloadDiagnostic {
	seq: number;
	provider: string;
	model: string;
	api: string;
	payload: ContentAddressedBlobRef;
	previousPayload?: ContentAddressedBlobRef;
	commonPrefixBytes: number;
	deltaBytes: number;
	stablePrefixRatio: number;
	invalidationReason: ProviderPayloadInvalidationReason;
}

export interface DurableJournalRecord {
	seq: number;
	at: number;
	operationId: string;
	sessionId: string;
	lane: string;
	operationKind: DurableOperationKind;
	type: string;
	data: unknown;
}

export interface DurableProcessIdentity {
	pid: number;
	instanceId: string;
	startedAt: number;
}

export interface DurableProcessExitDiagnostic {
	seq: number;
	kind: "unclean_exit";
	previousProcess?: DurableProcessIdentity;
	detectedBy: DurableProcessIdentity;
	lastRecordSeq: number;
}

export interface DurableOperationHandle {
	id: string;
	/** Defaults to main when omitted by legacy callers. */
	lane?: string;
	/** Defaults to run when omitted by legacy callers. */
	kind?: DurableOperationKind;
	attempt: number;
	recovered: boolean;
}

export interface DurableEffectSnapshot {
	key: string;
	assistantEntryId: string;
	toolIndex: number;
	toolCallId: string;
	toolName: string;
	argsHash?: string;
	replay?: DurableReplayPolicy;
	resultEntryId: string;
	status: DurableEffectStatus;
	result?: unknown;
	error?: string;
	reconciled?: boolean;
}

export interface DurablePreparedInput {
	messages: unknown[];
	systemPrompt?: string;
}

export interface DurableOperationBeginOptions {
	lane?: string;
	kind?: DurableOperationKind;
}

export interface DurableOperationSnapshot {
	id: string;
	sessionId: string;
	lane: string;
	kind: DurableOperationKind;
	prompt: string;
	status: DurableOperationStatus;
	attempt: number;
	createdAt: number;
	updatedAt: number;
	checkpointCount: number;
	lastCheckpoint?: { kind: string; data?: unknown; at: number };
	effects: DurableEffectSnapshot[];
	verificationReceipts: VerificationReceipt[];
	providerPayloads: ProviderPayloadDiagnostic[];
	processExits: DurableProcessExitDiagnostic[];
	ownerProcess?: DurableProcessIdentity;
	prepared?: DurablePreparedInput;
	error?: string;
}

/**
 * Runtime-owned durable operation boundary.
 *
 * AgentSession depends on this contract rather than the JSONL sidecar class.
 * One implementation is authoritative for a session; adapters must not mirror
 * transitions into a second operation store. Implementations must make close
 * idempotent because ownership can be released along constructor error paths.
 */
export interface DurableOperationStore {
	readonly sessionId: string;
	close(): void;
	recoverInFlight(lane?: string): DurableOperationSnapshot | undefined;
	begin(
		prompt: string,
		prepared?: DurablePreparedInput,
		options?: DurableOperationBeginOptions,
	): DurableOperationHandle;
	updatePrepared(operation: DurableOperationHandle, prepared: DurablePreparedInput): void;
	resume(lane?: string): { operation: DurableOperationHandle; prompt: string };
	abortSuspended(reason?: string, lane?: string): DurableOperationSnapshot;
	checkpoint(operation: DurableOperationHandle, kind: string, data?: unknown): void;
	suspend(operation: DurableOperationHandle, error: string): DurableOperationSnapshot;
	reserveEffect(
		operation: DurableOperationHandle,
		input: {
			assistantEntryId: string;
			toolIndex: number;
			toolCallId: string;
			toolName: string;
		},
	): { key: string; resultEntryId: string };
	dispatchEffect(
		operation: DurableOperationHandle,
		key: string,
		input: { args: unknown; replay: DurableReplayPolicy },
	): DurableEffectClaim;
	finishEffect(
		operation: DurableOperationHandle,
		key: string,
		status: "completed" | "failed",
		result?: unknown,
		error?: string,
	): void;
	recordVerification(operation: DurableOperationHandle, receipt: VerificationReceipt): void;
	recordProviderPayload(
		operation: DurableOperationHandle,
		input: { provider: string; model: string; api: string; payload: unknown },
	): ProviderPayloadDiagnostic;
	markEffectReconciled(operationId: string, key: string): void;
	finish(operation: DurableOperationHandle, outcome: DurableOperationOutcome, error?: string): void;
	latestSuspended(lane?: string): DurableOperationSnapshot | undefined;
	/** Returns every open operation when lane is omitted. */
	findOpenOperations(lane?: string): DurableOperationSnapshot[];
}

/**
 * Convert every interrupted lane into an explicit suspended state before a
 * runtime starts accepting new work. This keeps uncertain effects visible even
 * when the classic CLI only drives the main lane.
 */
export function recoverDurableOperations(store: DurableOperationStore): DurableOperationSnapshot[] {
	const recovered: DurableOperationSnapshot[] = [];
	for (const operation of store.findOpenOperations()) {
		const snapshot = store.recoverInFlight(operation.lane);
		if (snapshot) recovered.push(snapshot);
	}
	return recovered;
}

interface DurableRecordBase {
	schema: 1;
	seq: number;
	at: number;
	operationId: string;
	sessionId: string;
}

type DurableRecord =
	| (DurableRecordBase & {
			type: "operation_started";
			prompt: string;
			/** Missing on legacy schema-1 records; defaults to main. */
			lane?: string;
			/** Missing on legacy schema-1 records; defaults to run. */
			operationKind?: DurableOperationKind;
			prepared?: DurablePreparedInput;
			process?: DurableProcessIdentity;
	  })
	| (DurableRecordBase & { type: "prepared_updated"; prepared: DurablePreparedInput })
	| (DurableRecordBase & { type: "task_attempt"; attempt: number; recovered: boolean })
	| (DurableRecordBase & { type: "checkpoint"; kind: string; data?: unknown })
	| (DurableRecordBase & {
			type: "tool_reserved";
			key: string;
			assistantEntryId: string;
			toolIndex: number;
			toolCallId: string;
			toolName: string;
			resultEntryId: string;
	  })
	| (DurableRecordBase & {
			type: "tool_dispatched";
			key: string;
			argsHash: string;
			replay: DurableReplayPolicy;
	  })
	| (DurableRecordBase & {
			type: "tool_settled";
			key: string;
			status: "completed" | "failed";
			result?: unknown;
			error?: string;
	  })
	// Legacy schema-1 records written before reservation and dispatch were split.
	| (DurableRecordBase & {
			type: "tool_started";
			key: string;
			assistantEntryId: string;
			toolIndex: number;
			toolCallId: string;
			toolName: string;
			argsHash: string;
			replay: DurableReplayPolicy;
			resultEntryId: string;
	  })
	| (DurableRecordBase & {
			type: "tool_finished";
			key: string;
			status: "completed" | "failed";
			result?: unknown;
			error?: string;
	  })
	| (DurableRecordBase & { type: "tool_interrupted"; key: string })
	| (DurableRecordBase & { type: "tool_reconciled"; key: string })
	| (DurableRecordBase & { type: "tool_reused"; key: string; sourceKey: string })
	| (DurableRecordBase & { type: "verification_recorded"; receipt: VerificationReceipt })
	| (DurableRecordBase & {
			type: "provider_payload_recorded";
			diagnostic: Omit<ProviderPayloadDiagnostic, "seq">;
	  })
	| (DurableRecordBase & {
			type: "process_exit_recorded";
			diagnostic: Omit<DurableProcessExitDiagnostic, "seq">;
	  })
	| (DurableRecordBase & { type: "operation_suspended"; error: string })
	| (DurableRecordBase & { type: "resume_requested"; attempt: number })
	| (DurableRecordBase & { type: "abort_requested"; reason: string })
	| (DurableRecordBase & {
			type: "operation_finished";
			outcome: DurableOperationOutcome;
			error?: string;
	  });

type WithoutRecordEnvelope<T> = T extends unknown ? Omit<T, "schema" | "seq" | "at"> : never;
type NewDurableRecord = WithoutRecordEnvelope<DurableRecord>;

export type DurableEffectClaim =
	| { kind: "execute"; key: string; resultEntryId: string }
	| { kind: "reuse"; key: string; result: unknown };

interface DurableLeaseOwner {
	schema: 1;
	pid: number;
	token: string;
	createdAt: number;
}

function getErrorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function parseLeaseOwner(value: unknown): DurableLeaseOwner | undefined {
	if (!value || typeof value !== "object") return undefined;
	const owner = value as Record<string, unknown>;
	if (
		owner.schema !== 1 ||
		typeof owner.pid !== "number" ||
		!Number.isInteger(owner.pid) ||
		owner.pid <= 0 ||
		typeof owner.token !== "string" ||
		typeof owner.createdAt !== "number"
	) {
		return undefined;
	}
	return owner as unknown as DurableLeaseOwner;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return getErrorCode(error) === "EPERM";
	}
}

class DurableWriterLease {
	private readonly lockPath: string;
	private readonly ownerPath: string;
	private readonly token = randomUUID();
	private released = false;

	constructor(journalPath: string) {
		this.lockPath = `${journalPath}.lock`;
		this.ownerPath = join(this.lockPath, "owner.json");
		this.acquire();
	}

	release(): void {
		if (this.released) return;
		this.released = true;
		try {
			const owner = parseLeaseOwner(JSON.parse(readFileSync(this.ownerPath, "utf8")) as unknown);
			if (owner?.token !== this.token) return;
			unlinkSync(this.ownerPath);
			rmdirSync(this.lockPath);
		} catch {
			// Lease cleanup is best effort. A stale owner is reclaimed on next open.
		}
	}

	private acquire(): void {
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				mkdirSync(this.lockPath, { mode: 0o700 });
				try {
					const owner: DurableLeaseOwner = {
						schema: 1,
						pid: process.pid,
						token: this.token,
						createdAt: Date.now(),
					};
					writeFileSync(this.ownerPath, `${JSON.stringify(owner)}\n`, {
						encoding: "utf8",
						flag: "wx",
						mode: 0o600,
					});
					return;
				} catch (error) {
					try {
						rmdirSync(this.lockPath);
					} catch {
						// Preserve the original acquisition error.
					}
					throw error;
				}
			} catch (error) {
				if (getErrorCode(error) !== "EEXIST") throw error;
			}

			const owner = this.readOwner();
			if (owner && isProcessAlive(owner.pid)) {
				throw new Error(`Session is already open for durable writes by process ${owner.pid}.`);
			}
			if (!owner && Date.now() - statSync(this.lockPath).mtimeMs < 2_000) {
				throw new Error("Session durable writer lease is still being initialized.");
			}

			const stalePath = `${this.lockPath}.stale-${this.token}`;
			try {
				renameSync(this.lockPath, stalePath);
				const staleOwnerPath = join(stalePath, "owner.json");
				if (existsSync(staleOwnerPath)) unlinkSync(staleOwnerPath);
				rmdirSync(stalePath);
			} catch (error) {
				if (getErrorCode(error) !== "ENOENT") throw error;
			}
		}
		throw new Error("Failed to acquire durable session writer lease.");
	}

	private readOwner(): DurableLeaseOwner | undefined {
		try {
			return parseLeaseOwner(JSON.parse(readFileSync(this.ownerPath, "utf8")) as unknown);
		} catch {
			return undefined;
		}
	}
}

export interface DurableOperationLease {
	/** Canonical journal path this lease protects. */
	readonly journalPath: string;
	/**
	 * Transfer this lease to exactly one journal.
	 *
	 * The returned owner, not the original transfer handle, controls release
	 * after a successful transfer.
	 */
	consume(journalPath: string): { release(): void };
	release(): void;
}

class TransferableDurableOperationLease implements DurableOperationLease {
	readonly journalPath: string;
	private readonly writerLease: DurableWriterLease;
	private consumed = false;
	private released = false;

	constructor(journalPath: string) {
		this.journalPath = resolve(journalPath);
		this.writerLease = new DurableWriterLease(this.journalPath);
	}

	consume(journalPath: string): { release(): void } {
		if (this.released) {
			throw new Error(`Durable operation lease for ${this.journalPath} was already released.`);
		}
		if (this.consumed) {
			throw new Error(`Durable operation lease for ${this.journalPath} was already transferred.`);
		}
		const resolvedJournalPath = resolve(journalPath);
		if (resolvedJournalPath !== this.journalPath) {
			throw new Error(
				`Durable operation lease path mismatch: expected ${this.journalPath}, received ${resolvedJournalPath}.`,
			);
		}
		this.consumed = true;
		return {
			release: () => this.writerLease.release(),
		};
	}

	release(): void {
		if (this.released || this.consumed) return;
		this.released = true;
		this.writerLease.release();
	}
}

export function acquireDurableOperationLease(journalPath: string): DurableOperationLease {
	const resolvedJournalPath = resolve(journalPath);
	mkdirSync(dirname(resolvedJournalPath), { recursive: true, mode: 0o700 });
	return new TransferableDurableOperationLease(resolvedJournalPath);
}

export function getDurableOperationArtifactPaths(journalPath: string): {
	journalPath: string;
	blobsPath: string;
	consumersPath: string;
} {
	const resolvedJournalPath = resolve(journalPath);
	return {
		journalPath: resolvedJournalPath,
		blobsPath: `${resolvedJournalPath}.blobs`,
		consumersPath: `${resolvedJournalPath}.consumers.json`,
	};
}

function canonicalize(value: unknown, seen = new WeakSet<object>()): unknown {
	if (Array.isArray(value)) {
		if (seen.has(value)) return { circular: true };
		seen.add(value);
		const result = value.map((item) => canonicalize(item, seen));
		seen.delete(value);
		return result;
	}
	if (value && typeof value === "object") {
		if (seen.has(value)) return { circular: true };
		seen.add(value);
		const input = value as Record<string, unknown>;
		const entries = Object.keys(input)
			.sort()
			.flatMap((key): Array<[string, unknown]> => {
				const item = input[key];
				if (item === undefined || typeof item === "function" || typeof item === "symbol") {
					return [];
				}
				return [[key, canonicalize(item, seen)]];
			});
		seen.delete(value);
		return Object.fromEntries(entries);
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	return value;
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value) ?? null);
}

export function durableValueFingerprint(value: unknown): string {
	return hash(canonicalJson(value));
}

function cloneJson(value: unknown): unknown {
	return JSON.parse(canonicalJson(value)) as unknown;
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function commonPrefixBytes(left: Uint8Array, right: Uint8Array): number {
	const limit = Math.min(left.length, right.length);
	let index = 0;
	while (index < limit && left[index] === right[index]) index += 1;
	return index;
}

interface DurableConsumerOffsetFile {
	schema: 1;
	sessionId: string;
	offsets: Record<string, number>;
}

function isConsumerOffsetFile(value: unknown): value is DurableConsumerOffsetFile {
	if (!value || typeof value !== "object") return false;
	const file = value as Record<string, unknown>;
	if (file.schema !== 1 || typeof file.sessionId !== "string" || !file.offsets || typeof file.offsets !== "object") {
		return false;
	}
	return Object.entries(file.offsets).every(
		([consumerId, offset]) =>
			consumerId.length > 0 &&
			consumerId.length <= 128 &&
			typeof offset === "number" &&
			Number.isSafeInteger(offset) &&
			offset >= 0,
	);
}

function cloneEffect(effect: DurableEffectSnapshot): DurableEffectSnapshot {
	return {
		...effect,
		result: effect.result === undefined ? undefined : cloneJson(effect.result),
	};
}

function cloneSnapshot(snapshot: DurableOperationSnapshot): DurableOperationSnapshot {
	return {
		...snapshot,
		prepared: snapshot.prepared
			? {
					messages: cloneJson(snapshot.prepared.messages) as unknown[],
					systemPrompt: snapshot.prepared.systemPrompt,
				}
			: undefined,
		lastCheckpoint: snapshot.lastCheckpoint
			? {
					...snapshot.lastCheckpoint,
					data: snapshot.lastCheckpoint.data === undefined ? undefined : cloneJson(snapshot.lastCheckpoint.data),
				}
			: undefined,
		effects: snapshot.effects.map((effect) => cloneEffect(effect)),
		verificationReceipts: cloneJson(snapshot.verificationReceipts) as VerificationReceipt[],
		providerPayloads: cloneJson(snapshot.providerPayloads) as ProviderPayloadDiagnostic[],
		processExits: cloneJson(snapshot.processExits) as DurableProcessExitDiagnostic[],
		ownerProcess: snapshot.ownerProcess ? { ...snapshot.ownerProcess } : undefined,
	};
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function isDurableOperationLane(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 256 &&
		!value.includes("\0") &&
		!value.includes("\r") &&
		!value.includes("\n")
	);
}

function resolveDurableOperationLane(lane = DEFAULT_DURABLE_OPERATION_LANE): string {
	if (!isDurableOperationLane(lane)) {
		throw new Error("Durable operation lane must be 1-256 characters without NUL or newlines.");
	}
	return lane;
}

function isDurableOperationKind(value: unknown): value is DurableOperationKind {
	return value === "run" || value === "compaction" || value === "navigation";
}

function hasRecordEnvelope(record: Record<string, unknown>): boolean {
	return (
		record.schema === 1 &&
		(record.seq === undefined ||
			(typeof record.seq === "number" && Number.isSafeInteger(record.seq) && record.seq > 0)) &&
		typeof record.type === "string" &&
		typeof record.at === "number" &&
		Number.isFinite(record.at) &&
		typeof record.operationId === "string" &&
		record.operationId.length > 0 &&
		typeof record.sessionId === "string" &&
		record.sessionId.length > 0
	);
}

function isProviderPayloadDiagnostic(value: unknown): value is Omit<ProviderPayloadDiagnostic, "seq"> {
	if (!value || typeof value !== "object") return false;
	const diagnostic = value as Record<string, unknown>;
	return (
		typeof diagnostic.provider === "string" &&
		diagnostic.provider.length > 0 &&
		typeof diagnostic.model === "string" &&
		diagnostic.model.length > 0 &&
		typeof diagnostic.api === "string" &&
		diagnostic.api.length > 0 &&
		isContentAddressedBlobRef(diagnostic.payload) &&
		(diagnostic.previousPayload === undefined || isContentAddressedBlobRef(diagnostic.previousPayload)) &&
		typeof diagnostic.commonPrefixBytes === "number" &&
		Number.isSafeInteger(diagnostic.commonPrefixBytes) &&
		diagnostic.commonPrefixBytes >= 0 &&
		typeof diagnostic.deltaBytes === "number" &&
		Number.isSafeInteger(diagnostic.deltaBytes) &&
		diagnostic.deltaBytes >= 0 &&
		typeof diagnostic.stablePrefixRatio === "number" &&
		Number.isFinite(diagnostic.stablePrefixRatio) &&
		diagnostic.stablePrefixRatio >= 0 &&
		diagnostic.stablePrefixRatio <= 1 &&
		(diagnostic.invalidationReason === "first_request" ||
			diagnostic.invalidationReason === "none" ||
			diagnostic.invalidationReason === "provider_changed" ||
			diagnostic.invalidationReason === "model_changed" ||
			diagnostic.invalidationReason === "api_changed" ||
			diagnostic.invalidationReason === "payload_shrank" ||
			diagnostic.invalidationReason === "prefix_changed")
	);
}

function isDurableProcessIdentity(value: unknown): value is DurableProcessIdentity {
	return (
		!!value &&
		typeof value === "object" &&
		"pid" in value &&
		typeof value.pid === "number" &&
		Number.isSafeInteger(value.pid) &&
		value.pid > 0 &&
		"instanceId" in value &&
		typeof value.instanceId === "string" &&
		value.instanceId.length > 0 &&
		"startedAt" in value &&
		typeof value.startedAt === "number" &&
		Number.isFinite(value.startedAt) &&
		value.startedAt >= 0
	);
}

function isProcessExitDiagnostic(value: unknown): value is Omit<DurableProcessExitDiagnostic, "seq"> {
	return (
		!!value &&
		typeof value === "object" &&
		"kind" in value &&
		value.kind === "unclean_exit" &&
		(!("previousProcess" in value) ||
			value.previousProcess === undefined ||
			isDurableProcessIdentity(value.previousProcess)) &&
		"detectedBy" in value &&
		isDurableProcessIdentity(value.detectedBy) &&
		"lastRecordSeq" in value &&
		typeof value.lastRecordSeq === "number" &&
		Number.isSafeInteger(value.lastRecordSeq) &&
		value.lastRecordSeq >= 0
	);
}

function isDurableRecord(value: unknown): value is DurableRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (!hasRecordEnvelope(record)) return false;

	switch (record.type) {
		case "operation_started": {
			if (typeof record.prompt !== "string") return false;
			if (record.lane !== undefined && !isDurableOperationLane(record.lane)) return false;
			if (record.operationKind !== undefined && !isDurableOperationKind(record.operationKind)) return false;
			if (record.process !== undefined && !isDurableProcessIdentity(record.process)) return false;
			if (record.prepared === undefined) return true;
			if (!record.prepared || typeof record.prepared !== "object") return false;
			const prepared = record.prepared as Record<string, unknown>;
			return Array.isArray(prepared.messages) && isOptionalString(prepared.systemPrompt);
		}
		case "prepared_updated": {
			if (!record.prepared || typeof record.prepared !== "object") return false;
			const prepared = record.prepared as Record<string, unknown>;
			return Array.isArray(prepared.messages) && isOptionalString(prepared.systemPrompt);
		}
		case "task_attempt":
			return (
				typeof record.attempt === "number" &&
				Number.isInteger(record.attempt) &&
				record.attempt > 0 &&
				typeof record.recovered === "boolean"
			);
		case "checkpoint":
			return typeof record.kind === "string" && record.kind.length > 0;
		case "tool_reserved":
			return (
				typeof record.key === "string" &&
				record.key.length > 0 &&
				typeof record.assistantEntryId === "string" &&
				record.assistantEntryId.length > 0 &&
				typeof record.toolIndex === "number" &&
				Number.isInteger(record.toolIndex) &&
				record.toolIndex >= 0 &&
				typeof record.toolCallId === "string" &&
				record.toolCallId.length > 0 &&
				typeof record.toolName === "string" &&
				record.toolName.length > 0 &&
				typeof record.resultEntryId === "string" &&
				record.resultEntryId.length > 0
			);
		case "tool_dispatched":
			return (
				typeof record.key === "string" &&
				record.key.length > 0 &&
				typeof record.argsHash === "string" &&
				record.argsHash.length > 0 &&
				(record.replay === "safe" || record.replay === "never")
			);
		case "tool_started":
			return (
				typeof record.key === "string" &&
				record.key.length > 0 &&
				typeof record.assistantEntryId === "string" &&
				record.assistantEntryId.length > 0 &&
				typeof record.toolIndex === "number" &&
				Number.isInteger(record.toolIndex) &&
				record.toolIndex >= 0 &&
				typeof record.toolCallId === "string" &&
				record.toolCallId.length > 0 &&
				typeof record.toolName === "string" &&
				record.toolName.length > 0 &&
				typeof record.argsHash === "string" &&
				record.argsHash.length > 0 &&
				(record.replay === "safe" || record.replay === "never") &&
				typeof record.resultEntryId === "string" &&
				record.resultEntryId.length > 0
			);
		case "tool_settled":
		case "tool_finished":
			return (
				typeof record.key === "string" &&
				record.key.length > 0 &&
				(record.status === "completed" || record.status === "failed") &&
				isOptionalString(record.error)
			);
		case "tool_interrupted":
		case "tool_reconciled":
			return typeof record.key === "string" && record.key.length > 0;
		case "tool_reused":
			return (
				typeof record.key === "string" &&
				record.key.length > 0 &&
				typeof record.sourceKey === "string" &&
				record.sourceKey.length > 0
			);
		case "verification_recorded":
			return isVerificationReceipt(record.receipt);
		case "provider_payload_recorded":
			return isProviderPayloadDiagnostic(record.diagnostic);
		case "process_exit_recorded":
			return isProcessExitDiagnostic(record.diagnostic);
		case "operation_suspended":
			return typeof record.error === "string";
		case "resume_requested":
			return typeof record.attempt === "number" && Number.isInteger(record.attempt) && record.attempt > 0;
		case "abort_requested":
			return typeof record.reason === "string";
		case "operation_finished":
			return (
				(record.outcome === "completed" || record.outcome === "failed" || record.outcome === "aborted") &&
				isOptionalString(record.error)
			);
		default:
			return false;
	}
}

/**
 * Append-only, process-crash durable operation log for one Pi session.
 *
 * The JSONL file is deliberately separate from the v3 session transcript.
 * Upstream session files remain readable, while interrupted operations and
 * tool effects can be reduced independently.
 */
export class DurableOperationJournal implements DurableOperationStore {
	readonly path: string;
	readonly sessionId: string;
	private readonly lease: { release(): void } | undefined;
	private readonly blobStore: ContentAddressedStore;
	private readonly processIdentity: DurableProcessIdentity;
	private readonly operations = new Map<string, DurableOperationSnapshot>();
	private readonly effects = new Map<string, Map<string, DurableEffectSnapshot>>();
	private readonly records: DurableRecord[] = [];
	private readonly resumeRequests = new Map<string, number>();
	private readonly abortRequests = new Set<string>();
	private readonly consumerOffsets = new Map<string, number>();
	private sequence = 0;
	private consumerOffsetsLoaded = false;
	private loaded = false;
	private closed = false;

	constructor(path: string, sessionId: string, options?: { exclusive?: boolean; lease?: DurableOperationLease }) {
		this.path = resolve(path);
		this.sessionId = sessionId;
		this.blobStore = new ContentAddressedStore(getDurableOperationArtifactPaths(this.path).blobsPath);
		this.processIdentity = { pid: process.pid, instanceId: randomUUID(), startedAt: Date.now() };
		if (options?.exclusive && options.lease) {
			throw new Error("Provide either an exclusive durable lease or a transferred lease, not both.");
		}
		if (options?.lease) {
			this.lease = options.lease.consume(this.path);
		} else if (options?.exclusive) {
			mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
			this.lease = new DurableWriterLease(this.path);
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.lease?.release();
	}

	recoverInFlight(lane = DEFAULT_DURABLE_OPERATION_LANE): DurableOperationSnapshot | undefined {
		const operation = this.latestOpen(resolveDurableOperationLane(lane));
		if (!operation || operation.status === "suspended") {
			return operation;
		}
		this.append({
			type: "process_exit_recorded",
			operationId: operation.id,
			sessionId: this.sessionId,
			diagnostic: {
				kind: "unclean_exit",
				previousProcess: operation.ownerProcess,
				detectedBy: this.processIdentity,
				lastRecordSeq: this.sequence,
			},
		});

		for (const effect of operation.effects) {
			if (effect.status === "dispatched") {
				this.append({
					type: "tool_interrupted",
					operationId: operation.id,
					sessionId: this.sessionId,
					key: effect.key,
				});
			}
		}
		this.append({
			type: "operation_suspended",
			operationId: operation.id,
			sessionId: this.sessionId,
			error: "Pi exited before the durable operation reached a terminal checkpoint",
		});
		return this.get(operation.id);
	}

	begin(
		prompt: string,
		prepared?: DurablePreparedInput,
		options: DurableOperationBeginOptions = {},
	): DurableOperationHandle {
		const lane = resolveDurableOperationLane(options.lane);
		const kind = options.kind ?? "run";
		if (!isDurableOperationKind(kind)) {
			throw new Error(`Unsupported durable operation kind: ${String(kind)}`);
		}
		const open = this.latestOpen(lane);
		if (open) {
			throw new Error(
				`Operation ${open.id} on lane ${lane} is ${open.status}. Run /recover to continue it or /recover abort to discard it.`,
			);
		}

		const operationId = randomUUID();
		this.append({
			type: "operation_started",
			operationId,
			sessionId: this.sessionId,
			prompt,
			lane,
			operationKind: kind,
			process: this.processIdentity,
			prepared: prepared
				? {
						messages: cloneJson(prepared.messages) as unknown[],
						systemPrompt: prepared.systemPrompt,
					}
				: undefined,
		});
		this.append({
			type: "task_attempt",
			operationId,
			sessionId: this.sessionId,
			attempt: 1,
			recovered: false,
		});
		return { id: operationId, lane, kind, attempt: 1, recovered: false };
	}

	updatePrepared(operation: DurableOperationHandle, prepared: DurablePreparedInput): void {
		this.requireHandle(operation);
		this.append({
			type: "prepared_updated",
			operationId: operation.id,
			sessionId: this.sessionId,
			prepared: {
				messages: cloneJson(prepared.messages) as unknown[],
				systemPrompt: prepared.systemPrompt,
			},
		});
	}

	resume(lane = DEFAULT_DURABLE_OPERATION_LANE): { operation: DurableOperationHandle; prompt: string } {
		const suspended = this.latestSuspended(resolveDurableOperationLane(lane));
		if (!suspended) {
			throw new Error("No suspended operation is available for this session.");
		}
		if (this.abortRequests.has(suspended.id)) {
			throw new Error(`Operation ${suspended.id} has a pending abort request. Run /recover abort to finish it.`);
		}
		const attempt = suspended.attempt + 1;
		this.append({
			type: "task_attempt",
			operationId: suspended.id,
			sessionId: this.sessionId,
			attempt,
			recovered: true,
		});
		return {
			operation: {
				id: suspended.id,
				lane: suspended.lane,
				kind: suspended.kind,
				attempt,
				recovered: true,
			},
			prompt: suspended.prompt,
		};
	}

	abortSuspended(reason = "discarded by operator", lane = DEFAULT_DURABLE_OPERATION_LANE): DurableOperationSnapshot {
		const suspended = this.latestSuspended(resolveDurableOperationLane(lane));
		if (!suspended) {
			throw new Error("No suspended operation is available for this session.");
		}
		this.finish(
			{
				id: suspended.id,
				lane: suspended.lane,
				kind: suspended.kind,
				attempt: suspended.attempt,
				recovered: true,
			},
			"aborted",
			reason,
		);
		return this.get(suspended.id)!;
	}

	checkpoint(operation: DurableOperationHandle, kind: string, data?: unknown): void {
		this.requireHandle(operation);
		this.append({
			type: "checkpoint",
			operationId: operation.id,
			sessionId: this.sessionId,
			kind,
			data: data === undefined ? undefined : cloneJson(data),
		});
	}

	suspend(operation: DurableOperationHandle, error: string): DurableOperationSnapshot {
		this.requireHandle(operation);
		this.append({
			type: "operation_suspended",
			operationId: operation.id,
			sessionId: this.sessionId,
			error,
		});
		return this.get(operation.id)!;
	}

	claimEffect(
		operation: DurableOperationHandle,
		input: {
			assistantEntryId: string;
			toolIndex: number;
			toolCallId: string;
			toolName: string;
			args: unknown;
			replay: DurableReplayPolicy;
		},
	): DurableEffectClaim {
		const reservation = this.reserveEffect(operation, input);
		return this.dispatchEffect(operation, reservation.key, { args: input.args, replay: input.replay });
	}

	reserveEffect(
		operation: DurableOperationHandle,
		input: {
			assistantEntryId: string;
			toolIndex: number;
			toolCallId: string;
			toolName: string;
		},
	): { key: string; resultEntryId: string } {
		const snapshot = this.requireHandle(operation);
		const key = `effect:${hash(`${operation.id}\0${input.assistantEntryId}\0${input.toolIndex}`)}`;
		const exact = snapshot.effects.find((effect) => effect.key === key);
		if (exact) {
			if (
				exact.assistantEntryId !== input.assistantEntryId ||
				exact.toolIndex !== input.toolIndex ||
				exact.toolCallId !== input.toolCallId ||
				exact.toolName !== input.toolName
			) {
				throw new Error(`Durable effect identity mismatch for tool call ${input.toolCallId}`);
			}
			return { key, resultEntryId: exact.resultEntryId };
		}

		const resultEntryId = `tool-result:${hash(`${key}\0result`).slice(0, 32)}`;
		this.append({
			type: "tool_reserved",
			operationId: operation.id,
			sessionId: this.sessionId,
			key,
			assistantEntryId: input.assistantEntryId,
			toolIndex: input.toolIndex,
			toolCallId: input.toolCallId,
			toolName: input.toolName,
			resultEntryId,
		});
		return { key, resultEntryId };
	}

	dispatchEffect(
		operation: DurableOperationHandle,
		key: string,
		input: { args: unknown; replay: DurableReplayPolicy },
	): DurableEffectClaim {
		const snapshot = this.requireHandle(operation);
		const argsJson = canonicalJson(input.args);
		const argsHash = hash(argsJson);
		const exact = snapshot.effects.find((effect) => effect.key === key);
		if (!exact) {
			throw new Error(`Cannot dispatch unknown durable effect ${key}`);
		}
		if (exact.argsHash !== undefined && exact.argsHash !== argsHash) {
			throw new Error(`Durable effect identity mismatch for tool call ${exact.toolCallId}`);
		}
		if (exact.status === "completed" || exact.status === "failed") {
			return this.resolveExistingEffect(operation, key, exact);
		}
		if (exact.status === "dispatched") {
			throw new Error(`External effect ${key} was already dispatched.`);
		}
		if (exact.status === "unresolved") {
			if (
				!operation.recovered ||
				exact.replay !== "safe" ||
				input.replay !== "safe" ||
				exact.argsHash !== argsHash
			) {
				throw new Error(`External effect ${key} is unresolved; inspect current state before attempting it again.`);
			}
		}
		this.append({
			type: "tool_dispatched",
			operationId: operation.id,
			sessionId: this.sessionId,
			key,
			argsHash,
			replay: input.replay,
		});
		return { kind: "execute", key, resultEntryId: exact.resultEntryId };
	}

	finishEffect(
		operation: DurableOperationHandle,
		key: string,
		status: "completed" | "failed",
		result?: unknown,
		error?: string,
	): void {
		this.requireHandle(operation);
		this.append({
			type: "tool_settled",
			operationId: operation.id,
			sessionId: this.sessionId,
			key,
			status,
			result: result === undefined ? undefined : cloneJson(result),
			error,
		});
	}

	recordVerification(operation: DurableOperationHandle, receipt: VerificationReceipt): void {
		this.requireHandle(operation);
		if (receipt.operationId !== operation.id || receipt.sessionId !== this.sessionId) {
			throw new Error(`Verification receipt ${receipt.id} does not belong to durable operation ${operation.id}`);
		}
		this.append({
			type: "verification_recorded",
			operationId: operation.id,
			sessionId: this.sessionId,
			receipt: cloneJson(receipt) as VerificationReceipt,
		});
	}

	recordProviderPayload(
		operation: DurableOperationHandle,
		input: { provider: string; model: string; api: string; payload: unknown },
	): ProviderPayloadDiagnostic {
		const operationSnapshot = this.requireHandle(operation);
		let serialized: string | undefined;
		try {
			serialized = JSON.stringify(input.payload);
		} catch (error) {
			throw new Error("Provider payload is not JSON serializable.", { cause: error });
		}
		if (serialized === undefined) throw new Error("Provider payload serialized to undefined.");
		const bytes = Buffer.from(serialized);
		const payload = this.blobStore.put(bytes);
		this.ensureLoaded();
		const previousRecord = this.records
			.slice()
			.reverse()
			.find(
				(record) =>
					record.type === "provider_payload_recorded" &&
					this.operations.get(record.operationId)?.lane === operationSnapshot.lane,
			);
		const previous = previousRecord?.type === "provider_payload_recorded" ? previousRecord.diagnostic : undefined;
		let prefixBytes = 0;
		let invalidationReason: ProviderPayloadInvalidationReason = "first_request";
		if (previous) {
			if (previous.provider !== input.provider) {
				invalidationReason = "provider_changed";
			} else if (previous.model !== input.model) {
				invalidationReason = "model_changed";
			} else if (previous.api !== input.api) {
				invalidationReason = "api_changed";
			} else {
				const previousBytes = this.blobStore.get(previous.payload);
				prefixBytes = commonPrefixBytes(previousBytes, bytes);
				if (prefixBytes === previousBytes.length) {
					invalidationReason = "none";
				} else if (bytes.length < previousBytes.length) {
					invalidationReason = "payload_shrank";
				} else {
					invalidationReason = "prefix_changed";
				}
			}
		}
		const storedDiagnostic: Omit<ProviderPayloadDiagnostic, "seq"> = {
			provider: input.provider,
			model: input.model,
			api: input.api,
			payload,
			previousPayload: previous?.payload,
			commonPrefixBytes: prefixBytes,
			deltaBytes: bytes.length - prefixBytes,
			stablePrefixRatio: bytes.length === 0 ? 1 : prefixBytes / bytes.length,
			invalidationReason,
		};
		const record = this.append({
			type: "provider_payload_recorded",
			operationId: operation.id,
			sessionId: this.sessionId,
			diagnostic: storedDiagnostic,
		});
		return { seq: record.seq, ...storedDiagnostic };
	}

	readProviderPayload(ref: ContentAddressedBlobRef): unknown {
		return JSON.parse(this.blobStore.get(ref).toString("utf8")) as unknown;
	}

	markEffectReconciled(operationId: string, key: string): void {
		const operation = this.requireOpen(operationId);
		const effect = operation.effects.find((candidate) => candidate.key === key);
		if (!effect) {
			throw new Error(`Cannot reconcile unknown durable effect ${key}`);
		}
		if (effect.reconciled) return;
		this.append({
			type: "tool_reconciled",
			operationId,
			sessionId: this.sessionId,
			key,
		});
	}

	finish(operation: DurableOperationHandle, outcome: DurableOperationOutcome, error?: string): void {
		const current = this.requireHandle(operation);
		if (
			current.effects.some(
				(effect) =>
					(effect.status === "reserved" || effect.status === "dispatched" || effect.status === "unresolved") &&
					!effect.reconciled,
			)
		) {
			throw new Error(`Durable operation ${operation.id} still has an unresolved external effect`);
		}
		this.append({
			type: "operation_finished",
			operationId: operation.id,
			sessionId: this.sessionId,
			outcome,
			error,
		});
	}

	latestSuspended(lane = DEFAULT_DURABLE_OPERATION_LANE): DurableOperationSnapshot | undefined {
		const open = this.latestOpen(resolveDurableOperationLane(lane));
		return open?.status === "suspended" ? open : undefined;
	}

	findOpenOperations(lane?: string): DurableOperationSnapshot[] {
		const resolvedLane = lane === undefined ? undefined : resolveDurableOperationLane(lane);
		return this.reduce()
			.filter(
				(operation) =>
					(resolvedLane === undefined || operation.lane === resolvedLane) &&
					(operation.status === "accepted" || operation.status === "running" || operation.status === "suspended"),
			)
			.sort((left, right) => right.updatedAt - left.updatedAt);
	}

	get(operationId: string): DurableOperationSnapshot | undefined {
		return this.reduce().find((operation) => operation.id === operationId);
	}

	list(): DurableOperationSnapshot[] {
		return this.reduce().map((operation) => cloneSnapshot(operation));
	}

	getLog(options: { afterSeq?: number; limit?: number } = {}): DurableJournalRecord[] {
		this.ensureLoaded();
		if (options.afterSeq !== undefined && (!Number.isSafeInteger(options.afterSeq) || options.afterSeq < 0)) {
			throw new Error("Durable journal cursor must be a non-negative safe integer.");
		}
		if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit <= 0)) {
			throw new Error("Durable journal limit must be a positive safe integer.");
		}
		const items: DurableJournalRecord[] = [];
		for (const record of this.records) {
			if (options.afterSeq !== undefined && record.seq <= options.afterSeq) continue;
			const operation = this.operations.get(record.operationId);
			if (!operation) throw new Error(`Durable journal record references unknown operation ${record.operationId}`);
			const { schema: _schema, seq, at, operationId, sessionId, type, ...data } = record;
			items.push({
				seq,
				at,
				operationId,
				sessionId,
				lane: operation.lane,
				operationKind: operation.kind,
				type,
				data: cloneJson(data),
			});
			if (items.length === options.limit) break;
		}
		return items;
	}

	getConsumerOffset(consumerId: string): number {
		this.validateConsumerId(consumerId);
		this.loadConsumerOffsets();
		return this.consumerOffsets.get(consumerId) ?? 0;
	}

	advanceConsumerOffset(consumerId: string, expectedOffset: number, nextOffset: number): void {
		this.validateConsumerId(consumerId);
		this.ensureLoaded();
		this.loadConsumerOffsets();
		for (const [name, value] of [
			["expected", expectedOffset],
			["next", nextOffset],
		] as const) {
			if (!Number.isSafeInteger(value) || value < 0) {
				throw new Error(`Durable consumer ${name} offset must be a non-negative safe integer.`);
			}
		}
		const current = this.consumerOffsets.get(consumerId) ?? 0;
		if (current !== expectedOffset) {
			throw new Error(`Durable consumer ${consumerId} offset changed from ${expectedOffset} to ${current}.`);
		}
		if (nextOffset < current || nextOffset > this.sequence) {
			throw new Error(`Durable consumer ${consumerId} cannot advance to sequence ${nextOffset}.`);
		}
		this.consumerOffsets.set(consumerId, nextOffset);
		try {
			this.persistConsumerOffsets();
		} catch (error) {
			if (current === 0) this.consumerOffsets.delete(consumerId);
			else this.consumerOffsets.set(consumerId, current);
			throw error;
		}
	}

	private resolveExistingEffect(
		operation: DurableOperationHandle,
		key: string,
		effect: DurableEffectSnapshot,
	): DurableEffectClaim {
		if (effect.status === "completed") {
			this.append({
				type: "tool_reused",
				operationId: operation.id,
				sessionId: this.sessionId,
				key,
				sourceKey: effect.key,
			});
			return { kind: "reuse", key: effect.key, result: cloneJson(effect.result) };
		}
		if (effect.status === "failed") {
			throw new Error(effect.error ?? `Previous ${effect.toolName} execution failed`);
		}
		throw new Error(
			`External effect ${effect.key} is ${effect.status}; inspect current state before attempting it again.`,
		);
	}

	private latestOpen(lane: string): DurableOperationSnapshot | undefined {
		return this.findOpenOperations(lane)[0];
	}

	private requireOpen(operationId: string): DurableOperationSnapshot {
		const operation = this.get(operationId);
		if (!operation) {
			throw new Error(`Unknown durable operation: ${operationId}`);
		}
		if (operation.status === "completed" || operation.status === "failed" || operation.status === "aborted") {
			throw new Error(`Durable operation ${operationId} already finished with ${operation.status}`);
		}
		return operation;
	}

	private requireHandle(operation: DurableOperationHandle): DurableOperationSnapshot {
		const snapshot = this.requireOpen(operation.id);
		if (
			snapshot.lane !== (operation.lane ?? DEFAULT_DURABLE_OPERATION_LANE) ||
			snapshot.kind !== (operation.kind ?? "run")
		) {
			throw new Error(`Durable operation identity mismatch for ${operation.id}`);
		}
		return snapshot;
	}

	private validateConsumerId(consumerId: string): void {
		if (!/^[A-Za-z0-9._:-]{1,128}$/.test(consumerId)) {
			throw new Error("Durable consumer id must use 1-128 letters, numbers, dots, underscores, colons, or hyphens.");
		}
	}

	private loadConsumerOffsets(): void {
		if (this.consumerOffsetsLoaded) return;
		this.ensureLoaded();
		const path = getDurableOperationArtifactPaths(this.path).consumersPath;
		if (existsSync(path)) {
			let value: unknown;
			try {
				value = JSON.parse(readFileSync(path, "utf8")) as unknown;
			} catch (error) {
				throw new Error(`Corrupt durable consumer offsets: ${path}`, { cause: error });
			}
			if (!isConsumerOffsetFile(value) || value.sessionId !== this.sessionId) {
				throw new Error(`Corrupt durable consumer offsets: ${path}`);
			}
			for (const [consumerId, offset] of Object.entries(value.offsets)) {
				this.validateConsumerId(consumerId);
				if (offset > this.sequence) {
					throw new Error(`Durable consumer ${consumerId} points past journal sequence ${this.sequence}.`);
				}
				this.consumerOffsets.set(consumerId, offset);
			}
		}
		this.consumerOffsetsLoaded = true;
	}

	private persistConsumerOffsets(): void {
		if (this.closed) throw new Error("Durable operation journal is closed.");
		const path = getDurableOperationArtifactPaths(this.path).consumersPath;
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
		const file: DurableConsumerOffsetFile = {
			schema: 1,
			sessionId: this.sessionId,
			offsets: Object.fromEntries([...this.consumerOffsets].sort(([left], [right]) => left.localeCompare(right))),
		};
		try {
			writeFileSync(temporaryPath, `${JSON.stringify(file)}\n`, { flag: "wx", mode: 0o600 });
			renameSync(temporaryPath, path);
			try {
				chmodSync(path, 0o600);
			} catch {
				// Some filesystems do not expose POSIX mode bits.
			}
		} finally {
			if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
		}
	}

	private append(record: NewDurableRecord): DurableRecord {
		if (this.closed) {
			throw new Error("Durable operation journal is closed.");
		}
		this.ensureLoaded();
		const dir = dirname(this.path);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const nextSequence = this.sequence + 1;
		const persisted = { ...record, schema: 1, seq: nextSequence, at: Date.now() } as DurableRecord;
		this.validateRecordTransition(persisted);
		const line = `${JSON.stringify(persisted)}\n`;
		appendFileSync(this.path, line, { encoding: "utf8", mode: 0o600 });
		try {
			chmodSync(this.path, 0o600);
		} catch {
			// Some filesystems do not expose POSIX mode bits.
		}
		this.sequence = nextSequence;
		this.applyValidatedRecord(persisted);
		this.records.push(persisted);
		return persisted;
	}

	private readRecords(): DurableRecord[] {
		if (!existsSync(this.path)) return [];
		const text = readFileSync(this.path, "utf8");
		const lines = text.split("\n");
		const records: DurableRecord[] = [];
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index]!;
			if (!line.trim()) continue;
			let value: unknown;
			try {
				value = JSON.parse(line) as unknown;
			} catch (error) {
				const isUnterminatedTail = index === lines.length - 1 && !text.endsWith("\n");
				if (isUnterminatedTail) {
					const validPrefix = lines.slice(0, index).join("\n");
					truncateSync(this.path, Buffer.byteLength(validPrefix ? `${validPrefix}\n` : ""));
					break;
				}
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Corrupt durable operation journal at line ${index + 1}: ${message}`, {
					cause: error,
				});
			}
			if (!isDurableRecord(value)) {
				throw new Error(`Corrupt durable operation journal at line ${index + 1}: invalid durable operation record`);
			}
			const expectedSequence = records.length + 1;
			if (value.seq !== undefined && value.seq !== expectedSequence) {
				throw new Error(
					`Corrupt durable operation journal at line ${index + 1}: expected sequence ${expectedSequence}, received ${value.seq}`,
				);
			}
			const record = value.seq === undefined ? ({ ...value, seq: expectedSequence } as DurableRecord) : value;
			if (record.sessionId !== this.sessionId) {
				throw new Error(
					`Corrupt durable operation journal at line ${index + 1}: durable operation session mismatch: ${record.sessionId}`,
				);
			}
			records.push(record);
		}
		if (text.length > 0 && !text.endsWith("\n")) {
			appendFileSync(this.path, "\n", { encoding: "utf8", mode: 0o600 });
		}
		return records;
	}

	private reduce(): DurableOperationSnapshot[] {
		this.ensureLoaded();
		for (const operation of this.operations.values()) {
			operation.effects = [...this.effects.get(operation.id)!.values()].map((effect) => cloneEffect(effect));
		}
		return [...this.operations.values()].map((operation) => cloneSnapshot(operation));
	}

	private ensureLoaded(): void {
		if (this.loaded) return;
		for (const record of this.readRecords()) {
			this.validateRecordTransition(record);
			this.applyValidatedRecord(record);
			this.records.push(record);
			this.sequence = record.seq;
		}
		this.loaded = true;
	}

	private validateRecordTransition(record: DurableRecord): void {
		if (record.type === "operation_started") {
			if (this.operations.has(record.operationId)) {
				throw new Error(`Duplicate durable operation ${record.operationId}`);
			}
			const lane = resolveDurableOperationLane(record.lane);
			const existingOpen = [...this.operations.values()].find(
				(operation) =>
					operation.lane === lane &&
					(operation.status === "accepted" || operation.status === "running" || operation.status === "suspended"),
			);
			if (existingOpen) {
				throw new Error(
					`Cannot start a durable operation on lane ${lane} while ${existingOpen.id} is ${existingOpen.status}`,
				);
			}
			return;
		}

		const operation = this.operations.get(record.operationId);
		if (!operation) {
			throw new Error(`Durable operation record references unknown operation ${record.operationId}`);
		}
		if (operation.status === "completed" || operation.status === "failed" || operation.status === "aborted") {
			throw new Error(`Durable operation ${record.operationId} already finished with ${operation.status}`);
		}
		const operationEffects = this.effects.get(record.operationId)!;

		if (record.type === "prepared_updated") {
			if (
				operation.status !== "running" ||
				operation.checkpointCount !== 0 ||
				operationEffects.size !== 0 ||
				operation.prepared === undefined
			) {
				throw new Error(`Prepared input can no longer change for durable operation ${record.operationId}`);
			}
			return;
		}
		if (record.type === "task_attempt") {
			const expectedAttempt = operation.attempt + 1;
			const pendingResume = this.resumeRequests.get(record.operationId);
			const initialAttempt =
				operation.status === "accepted" &&
				operation.attempt === 0 &&
				record.attempt === 1 &&
				record.recovered === false;
			const recoveredAttempt =
				operation.status === "suspended" &&
				record.attempt === expectedAttempt &&
				record.recovered === true &&
				!this.abortRequests.has(record.operationId) &&
				(pendingResume === undefined || pendingResume === record.attempt);
			if (!initialAttempt && !recoveredAttempt) {
				throw new Error(`Invalid durable task attempt ${record.attempt} for operation ${record.operationId}`);
			}
			return;
		}
		if (record.type === "checkpoint") {
			if (operation.status !== "running") {
				throw new Error(`Cannot checkpoint durable operation ${record.operationId} while ${operation.status}`);
			}
			return;
		}
		if (record.type === "tool_reserved") {
			if (operation.status !== "running") {
				throw new Error(
					`Cannot reserve a durable effect while operation ${record.operationId} is ${operation.status}`,
				);
			}
			if (operationEffects.has(record.key)) {
				throw new Error(`Durable effect ${record.key} was already reserved`);
			}
			return;
		}
		if (record.type === "tool_dispatched") {
			const effect = operationEffects.get(record.key);
			if (operation.status !== "running" || !effect) {
				throw new Error(`Dispatch does not match a reserved durable effect ${record.key}`);
			}
			if (effect.status === "reserved") return;
			if (
				operation.attempt <= 1 ||
				effect.status !== "unresolved" ||
				effect.replay !== "safe" ||
				record.replay !== "safe" ||
				effect.argsHash !== record.argsHash
			) {
				throw new Error(`Invalid durable effect replay for ${record.key}`);
			}
			return;
		}
		if (record.type === "tool_started") {
			if (operation.status !== "running") {
				throw new Error(
					`Cannot start a durable effect while operation ${record.operationId} is ${operation.status}`,
				);
			}
			const existing = operationEffects.get(record.key);
			if (!existing) return;
			if (
				existing.assistantEntryId !== record.assistantEntryId ||
				existing.toolIndex !== record.toolIndex ||
				existing.toolCallId !== record.toolCallId ||
				existing.toolName !== record.toolName ||
				existing.argsHash !== record.argsHash ||
				existing.replay !== record.replay ||
				existing.resultEntryId !== record.resultEntryId
			) {
				throw new Error(`Durable effect identity changed for ${record.key}`);
			}
			if (
				operation.attempt <= 1 ||
				record.replay !== "safe" ||
				(existing.status !== "unresolved" && existing.status !== "failed")
			) {
				throw new Error(`Invalid durable effect replay for ${record.key}`);
			}
			return;
		}
		if (record.type === "tool_settled" || record.type === "tool_finished") {
			const effect = operationEffects.get(record.key);
			const validStatus =
				record.type === "tool_settled"
					? effect?.status === "reserved" || effect?.status === "dispatched"
					: effect?.status === "dispatched";
			if (operation.status !== "running" || !validStatus) {
				throw new Error(`Tool result does not match an active durable effect ${record.key}`);
			}
			return;
		}
		if (record.type === "tool_interrupted") {
			const effect = operationEffects.get(record.key);
			if (operation.status !== "running" || effect?.status !== "dispatched") {
				throw new Error(`Tool interruption does not match a dispatched durable effect ${record.key}`);
			}
			return;
		}
		if (record.type === "tool_reconciled") {
			const effect = operationEffects.get(record.key);
			if (operation.status !== "suspended" || !effect || effect.status === "dispatched" || effect.reconciled) {
				throw new Error(`Invalid durable effect reconciliation for ${record.key}`);
			}
			return;
		}
		if (record.type === "tool_reused") {
			const effect = operationEffects.get(record.key);
			const source = operationEffects.get(record.sourceKey);
			if (
				operation.status !== "running" ||
				!effect ||
				!source ||
				effect.key !== source.key ||
				source.status !== "completed"
			) {
				throw new Error(`Invalid durable effect reuse for ${record.key}`);
			}
			return;
		}
		if (record.type === "verification_recorded") {
			if (
				operation.status !== "running" ||
				record.receipt.operationId !== record.operationId ||
				record.receipt.sessionId !== record.sessionId ||
				operation.verificationReceipts.some((receipt) => receipt.id === record.receipt.id)
			) {
				throw new Error(`Invalid verification receipt ${record.receipt.id}`);
			}
			return;
		}
		if (record.type === "provider_payload_recorded") {
			if (operation.status !== "running") {
				throw new Error(
					`Cannot record a provider payload while operation ${record.operationId} is ${operation.status}`,
				);
			}
			const previousRecord = this.records
				.slice()
				.reverse()
				.find(
					(candidate) =>
						candidate.type === "provider_payload_recorded" &&
						this.operations.get(candidate.operationId)?.lane === operation.lane,
				);
			const previous = previousRecord?.type === "provider_payload_recorded" ? previousRecord.diagnostic : undefined;
			const diagnostic = record.diagnostic;
			const requiredLaneReason: ProviderPayloadInvalidationReason = !previous
				? "first_request"
				: previous.provider !== diagnostic.provider
					? "provider_changed"
					: previous.model !== diagnostic.model
						? "model_changed"
						: previous.api !== diagnostic.api
							? "api_changed"
							: diagnostic.invalidationReason;
			if (
				diagnostic.commonPrefixBytes > diagnostic.payload.bytes ||
				diagnostic.deltaBytes !== diagnostic.payload.bytes - diagnostic.commonPrefixBytes ||
				diagnostic.invalidationReason !== requiredLaneReason ||
				(previous
					? diagnostic.previousPayload?.digest !== previous.payload.digest ||
						diagnostic.commonPrefixBytes > previous.payload.bytes ||
						diagnostic.invalidationReason === "first_request"
					: diagnostic.previousPayload !== undefined ||
						diagnostic.commonPrefixBytes !== 0 ||
						diagnostic.invalidationReason !== "first_request")
			) {
				throw new Error(`Invalid provider payload diagnostic at sequence ${record.seq}`);
			}
			return;
		}
		if (record.type === "process_exit_recorded") {
			const previousProcess = operation.ownerProcess;
			const recordedPrevious = record.diagnostic.previousProcess;
			if (
				(operation.status !== "accepted" && operation.status !== "running") ||
				operation.processExits.length > 0 ||
				record.diagnostic.lastRecordSeq !== record.seq - 1 ||
				(previousProcess
					? recordedPrevious?.pid !== previousProcess.pid ||
						recordedPrevious.instanceId !== previousProcess.instanceId ||
						recordedPrevious.startedAt !== previousProcess.startedAt
					: recordedPrevious !== undefined)
			) {
				throw new Error(`Invalid process exit diagnostic at sequence ${record.seq}`);
			}
			return;
		}
		if (record.type === "operation_suspended") {
			const legacyInterruptedResume =
				operation.status === "suspended" && this.resumeRequests.has(record.operationId);
			if (operation.status !== "accepted" && operation.status !== "running" && !legacyInterruptedResume) {
				throw new Error(`Cannot suspend durable operation ${record.operationId} while ${operation.status}`);
			}
			return;
		}
		if (record.type === "resume_requested") {
			if (
				operation.status !== "suspended" ||
				record.attempt !== operation.attempt + 1 ||
				this.resumeRequests.has(record.operationId) ||
				this.abortRequests.has(record.operationId)
			) {
				throw new Error(`Invalid durable resume attempt ${record.attempt} for operation ${record.operationId}`);
			}
			return;
		}
		if (record.type === "abort_requested") {
			if (operation.status !== "suspended" || this.abortRequests.has(record.operationId)) {
				throw new Error(`Invalid durable abort request for operation ${record.operationId}`);
			}
			return;
		}
		if (record.type === "operation_finished") {
			const normalTerminal = operation.status === "running";
			const suspendedAbort = operation.status === "suspended" && record.outcome === "aborted";
			if (!normalTerminal && !suspendedAbort) {
				throw new Error(`Cannot finish durable operation ${record.operationId} while ${operation.status}`);
			}
			if (
				[...operationEffects.values()].some(
					(effect) =>
						(effect.status === "reserved" || effect.status === "dispatched" || effect.status === "unresolved") &&
						!effect.reconciled,
				)
			) {
				throw new Error(`Durable operation ${record.operationId} still has an unresolved external effect`);
			}
		}
	}

	private applyValidatedRecord(record: DurableRecord): void {
		if (record.type === "operation_started") {
			this.operations.set(record.operationId, {
				id: record.operationId,
				sessionId: record.sessionId,
				lane: record.lane ?? DEFAULT_DURABLE_OPERATION_LANE,
				kind: record.operationKind ?? "run",
				prompt: record.prompt,
				status: "accepted",
				attempt: 0,
				createdAt: record.at,
				updatedAt: record.at,
				checkpointCount: 0,
				effects: [],
				verificationReceipts: [],
				providerPayloads: [],
				processExits: [],
				ownerProcess: record.process ? { ...record.process } : undefined,
				prepared: record.prepared
					? {
							messages: cloneJson(record.prepared.messages) as unknown[],
							systemPrompt: record.prepared.systemPrompt,
						}
					: undefined,
			});
			this.effects.set(record.operationId, new Map());
			return;
		}

		const operation = this.operations.get(record.operationId);
		if (!operation) throw new Error(`Unknown durable operation ${record.operationId}`);
		operation.updatedAt = record.at;
		const operationEffects = this.effects.get(record.operationId)!;

		if (record.type === "prepared_updated") {
			operation.prepared = {
				messages: cloneJson(record.prepared.messages) as unknown[],
				systemPrompt: record.prepared.systemPrompt,
			};
		} else if (record.type === "task_attempt") {
			operation.status = "running";
			operation.attempt = record.attempt;
			operation.error = undefined;
			this.resumeRequests.delete(record.operationId);
		} else if (record.type === "checkpoint") {
			operation.checkpointCount += 1;
			operation.lastCheckpoint = {
				kind: record.kind,
				data: record.data,
				at: record.at,
			};
		} else if (record.type === "tool_reserved") {
			operationEffects.set(record.key, {
				key: record.key,
				assistantEntryId: record.assistantEntryId,
				toolIndex: record.toolIndex,
				toolCallId: record.toolCallId,
				toolName: record.toolName,
				resultEntryId: record.resultEntryId,
				status: "reserved",
			});
		} else if (record.type === "tool_dispatched") {
			const effect = operationEffects.get(record.key);
			if (!effect) {
				throw new Error(`Tool dispatch references unknown effect ${record.key}`);
			}
			effect.argsHash = record.argsHash;
			effect.replay = record.replay;
			effect.status = "dispatched";
			effect.result = undefined;
			effect.error = undefined;
			effect.reconciled = undefined;
		} else if (record.type === "tool_started") {
			operationEffects.set(record.key, {
				key: record.key,
				assistantEntryId: record.assistantEntryId,
				toolIndex: record.toolIndex,
				toolCallId: record.toolCallId,
				toolName: record.toolName,
				argsHash: record.argsHash,
				replay: record.replay,
				resultEntryId: record.resultEntryId,
				status: "dispatched",
			});
		} else if (record.type === "tool_settled" || record.type === "tool_finished") {
			const effect = operationEffects.get(record.key);
			if (!effect) {
				throw new Error(`Tool result references unknown effect ${record.key}`);
			}
			effect.status = record.status;
			effect.result = record.result;
			effect.error = record.error;
		} else if (record.type === "tool_interrupted") {
			const effect = operationEffects.get(record.key);
			if (!effect) {
				throw new Error(`Tool interruption references unknown effect ${record.key}`);
			}
			effect.status = "unresolved";
		} else if (record.type === "tool_reconciled") {
			const effect = operationEffects.get(record.key);
			if (!effect) {
				throw new Error(`Tool reconciliation references unknown effect ${record.key}`);
			}
			effect.reconciled = true;
		} else if (record.type === "verification_recorded") {
			operation.verificationReceipts.push(cloneJson(record.receipt) as VerificationReceipt);
		} else if (record.type === "provider_payload_recorded") {
			operation.providerPayloads.push({ seq: record.seq, ...record.diagnostic });
			operation.checkpointCount += 1;
			operation.lastCheckpoint = {
				kind: "provider_request",
				data: {
					provider: record.diagnostic.provider,
					model: record.diagnostic.model,
					api: record.diagnostic.api,
					payload: record.diagnostic.payload,
					commonPrefixBytes: record.diagnostic.commonPrefixBytes,
					stablePrefixRatio: record.diagnostic.stablePrefixRatio,
					invalidationReason: record.diagnostic.invalidationReason,
				},
				at: record.at,
			};
		} else if (record.type === "process_exit_recorded") {
			operation.processExits.push({ seq: record.seq, ...record.diagnostic });
		} else if (record.type === "operation_suspended") {
			operation.status = "suspended";
			operation.error = record.error;
			this.resumeRequests.delete(record.operationId);
			for (const effect of operationEffects.values()) {
				if (effect.status === "dispatched") {
					effect.status = "unresolved";
				}
			}
		} else if (record.type === "resume_requested") {
			this.resumeRequests.set(record.operationId, record.attempt);
		} else if (record.type === "abort_requested") {
			operation.error = record.reason;
			this.abortRequests.add(record.operationId);
		} else if (record.type === "operation_finished") {
			operation.status = record.outcome;
			operation.error = record.error;
			this.resumeRequests.delete(record.operationId);
			this.abortRequests.delete(record.operationId);
		}
	}
}
