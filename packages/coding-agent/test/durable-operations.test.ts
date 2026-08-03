import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDurableOperationLease, DurableOperationJournal } from "../src/core/durable-operations.ts";
import { runHostVerification } from "../src/core/verification.ts";

function invocation(toolCallId: string, assistantEntryId = "assistant-1", toolIndex = 0) {
	return { assistantEntryId, toolIndex, toolCallId };
}

describe("DurableOperationJournal", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	function createJournal(sessionId = "session-1"): DurableOperationJournal {
		tempDir = mkdtempSync(join(tmpdir(), "pi-durable-operations-"));
		return new DurableOperationJournal(join(tempDir, "operations.jsonl"), sessionId);
	}

	it("records acceptance, checkpoints, tool effects, and terminal outcome", () => {
		const journal = createJournal();
		const operation = journal.begin("Update the project");
		const claim = journal.claimEffect(operation, {
			...invocation("call-1"),
			toolName: "read",
			args: { path: "README.md" },
			replay: "safe",
		});
		expect(claim.kind).toBe("execute");
		if (claim.kind !== "execute") throw new Error("expected executable effect");

		journal.finishEffect(operation, claim.key, "completed", {
			content: [{ type: "text", text: "hello" }],
			details: {},
		});
		journal.checkpoint(operation, "tool_result", { toolCallId: "call-1" });
		journal.finish(operation, "completed");

		const snapshot = journal.get(operation.id);
		expect(snapshot).toMatchObject({
			prompt: "Update the project",
			status: "completed",
			attempt: 1,
			checkpointCount: 1,
		});
		expect(snapshot?.effects).toHaveLength(1);
		expect(snapshot?.effects[0]).toMatchObject({
			toolName: "read",
			replay: "safe",
			status: "completed",
		});
	});

	it("suspends an interrupted operation and marks a dispatched mutation unresolved", () => {
		const journal = createJournal();
		const operation = journal.begin("Deploy the project");
		journal.claimEffect(operation, {
			...invocation("call-1"),
			toolName: "bash",
			args: { command: "deploy" },
			replay: "never",
		});

		const restarted = new DurableOperationJournal(journal.path, journal.sessionId);
		const suspended = restarted.recoverInFlight();
		expect(suspended?.status).toBe("suspended");
		expect(suspended?.effects[0]?.status).toBe("unresolved");

		const resumed = restarted.resume().operation;
		expect(() =>
			restarted.claimEffect(resumed, {
				...invocation("call-1"),
				toolName: "bash",
				args: { command: "deploy" },
				replay: "never",
			}),
		).toThrow(/inspect current state/);
	});

	it("distinguishes a reserved tool call from a dispatched external effect", () => {
		const journal = createJournal();
		const operation = journal.begin("Deploy only after dispatch");
		const reservation = journal.reserveEffect(operation, {
			...invocation("call-1"),
			toolName: "bash",
		});

		const restarted = new DurableOperationJournal(journal.path, journal.sessionId);
		const suspended = restarted.recoverInFlight();
		expect(suspended?.effects[0]).toMatchObject({
			key: reservation.key,
			status: "reserved",
		});

		const resumed = restarted.resume().operation;
		expect(
			restarted.dispatchEffect(resumed, reservation.key, {
				args: { command: "deploy" },
				replay: "never",
			}),
		).toMatchObject({ kind: "execute", key: reservation.key });
	});

	it("settles validation and policy failures without dispatching externally", () => {
		const journal = createJournal();
		const operation = journal.begin("Reject an invalid call");
		const reservation = journal.reserveEffect(operation, {
			...invocation("call-1"),
			toolName: "missing",
		});
		journal.finishEffect(operation, reservation.key, "failed", { content: [{ type: "text", text: "missing" }] });

		const effect = journal.get(operation.id)?.effects[0];
		expect(effect).toMatchObject({ status: "failed" });
		expect(effect?.argsHash).toBeUndefined();
		expect(effect?.replay).toBeUndefined();
		expect(() => journal.finish(operation, "failed", "invalid tool")).not.toThrow();
	});

	it("persists host verification receipts independently of transcript entries", async () => {
		const journal = createJournal();
		const operation = journal.begin("Verify the project");
		const receipt = await runHostVerification(
			{ sessionId: journal.sessionId, operationId: operation.id, cwd: process.cwd() },
			{ id: "check", command: process.execPath, args: ["-e", "process.stdout.write('ok')"] },
		);
		journal.recordVerification(operation, receipt);
		journal.finish(operation, "completed");

		const restarted = new DurableOperationJournal(journal.path, journal.sessionId);
		expect(restarted.get(operation.id)?.verificationReceipts).toEqual([receipt]);
	});

	it("stores final provider payloads in CAS and records prefix invalidation evidence", () => {
		const journal = createJournal();
		const firstOperation = journal.begin("First request");
		const first = journal.recordProviderPayload(firstOperation, {
			provider: "provider-a",
			model: "model-a",
			api: "openai-responses",
			payload: { instructions: "stable", input: ["one"] },
		});
		journal.finish(firstOperation, "completed");

		const secondOperation = journal.begin("Second request");
		const second = journal.recordProviderPayload(secondOperation, {
			provider: "provider-a",
			model: "model-a",
			api: "openai-responses",
			payload: { instructions: "stable", input: ["one"] },
		});
		journal.finish(secondOperation, "completed");

		const thirdOperation = journal.begin("Third request");
		const third = journal.recordProviderPayload(thirdOperation, {
			provider: "provider-a",
			model: "model-a",
			api: "openai-responses",
			payload: { instructions: "stable", input: ["one", "two"] },
		});
		journal.finish(thirdOperation, "completed");

		const fourthOperation = journal.begin("Fourth request");
		const fourth = journal.recordProviderPayload(fourthOperation, {
			provider: "provider-b",
			model: "model-a",
			api: "openai-responses",
			payload: { instructions: "stable", input: ["one", "two"] },
		});
		journal.finish(fourthOperation, "completed");

		expect(first).toMatchObject({
			invalidationReason: "first_request",
			commonPrefixBytes: 0,
			previousPayload: undefined,
		});
		expect(second).toMatchObject({
			invalidationReason: "none",
			commonPrefixBytes: first.payload.bytes,
			deltaBytes: 0,
			previousPayload: first.payload,
		});
		expect(second.payload).toEqual(first.payload);
		expect(third.invalidationReason).toBe("prefix_changed");
		expect(third.commonPrefixBytes).toBeGreaterThan(0);
		expect(third.commonPrefixBytes).toBeLessThan(third.payload.bytes);
		expect(fourth).toMatchObject({
			invalidationReason: "provider_changed",
			commonPrefixBytes: 0,
			previousPayload: third.payload,
		});
		expect(journal.readProviderPayload(first.payload)).toEqual({ instructions: "stable", input: ["one"] });
		expect(journal.get(secondOperation.id)?.providerPayloads).toEqual([second]);
	});

	it("provides a sequenced production log with compare-and-set consumer offsets", () => {
		const journal = createJournal();
		const operation = journal.begin("Consume records");
		journal.checkpoint(operation, "prepared");
		journal.finish(operation, "completed");
		const log = journal.getLog();

		expect(log.map((record) => record.seq)).toEqual([1, 2, 3, 4]);
		expect(journal.getLog({ afterSeq: 2 }).map((record) => record.seq)).toEqual([3, 4]);
		journal.advanceConsumerOffset("indexer:main", 0, 4);
		expect(journal.getConsumerOffset("indexer:main")).toBe(4);
		expect(() => journal.advanceConsumerOffset("indexer:main", 0, 4)).toThrow(/changed from 0 to 4/);

		const reopened = new DurableOperationJournal(journal.path, journal.sessionId);
		expect(reopened.getConsumerOffset("indexer:main")).toBe(4);
		expect(reopened.getLog({ afterSeq: reopened.getConsumerOffset("indexer:main") })).toEqual([]);
	});

	it("provisions sequences for legacy records before appending new sequenced records", () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-durable-legacy-sequence-"));
		const path = join(tempDir, "operations.jsonl");
		const sessionId = "legacy-session";
		const operationId = "legacy-operation";
		writeFileSync(
			path,
			`${JSON.stringify({
				schema: 1,
				type: "operation_started",
				at: 1,
				operationId,
				sessionId,
				prompt: "legacy",
			})}\n${JSON.stringify({
				schema: 1,
				type: "task_attempt",
				at: 2,
				operationId,
				sessionId,
				attempt: 1,
				recovered: false,
			})}\n`,
		);
		const journal = new DurableOperationJournal(path, sessionId);
		journal.checkpoint({ id: operationId, attempt: 1, recovered: false }, "continued");

		expect(journal.getLog().map((record) => record.seq)).toEqual([1, 2, 3]);
		const rawRecords = readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { seq?: number });
		expect(rawRecords.map((record) => record.seq)).toEqual([undefined, undefined, 3]);
	});

	it("recovers a crash between operation acceptance and the first task attempt", () => {
		const journal = createJournal();
		const operationId = "accepted-only";
		appendFileSync(
			journal.path,
			`${JSON.stringify({
				schema: 1,
				type: "operation_started",
				at: Date.now(),
				operationId,
				sessionId: journal.sessionId,
				prompt: "Resume the accepted operation",
			})}\n`,
		);

		const restarted = new DurableOperationJournal(journal.path, journal.sessionId);
		expect(restarted.recoverInFlight()).toMatchObject({
			id: operationId,
			status: "suspended",
			attempt: 0,
		});
		expect(restarted.resume().operation).toEqual({
			id: operationId,
			attempt: 1,
			recovered: true,
		});
		expect(restarted.get(operationId)).toMatchObject({ status: "running", attempt: 1 });
	});

	it("finishes a legacy pending abort instead of resuming it", () => {
		const journal = createJournal();
		const operation = journal.begin("Abort after restart");
		journal.suspend(operation, "test interruption");
		appendFileSync(
			journal.path,
			`${JSON.stringify({
				schema: 1,
				type: "abort_requested",
				at: Date.now(),
				operationId: operation.id,
				sessionId: journal.sessionId,
				reason: "legacy pending abort",
			})}\n`,
		);

		const restarted = new DurableOperationJournal(journal.path, journal.sessionId);
		expect(() => restarted.resume()).toThrow(/pending abort request/);
		expect(restarted.abortSuspended()).toMatchObject({ status: "aborted" });
	});

	it("continues a legacy pending resume without writing another resume request", () => {
		const journal = createJournal();
		const operation = journal.begin("Resume after restart");
		journal.suspend(operation, "test interruption");
		appendFileSync(
			journal.path,
			`${JSON.stringify({
				schema: 1,
				type: "resume_requested",
				at: Date.now(),
				operationId: operation.id,
				sessionId: journal.sessionId,
				attempt: 2,
			})}\n`,
		);

		const restarted = new DurableOperationJournal(journal.path, journal.sessionId);
		expect(restarted.resume().operation).toMatchObject({ attempt: 2, recovered: true });
		expect(restarted.get(operation.id)).toMatchObject({ status: "running", attempt: 2 });
	});

	it("loads a legacy re-suspension after a crash during a requested resume", () => {
		const journal = createJournal();
		const operation = journal.begin("Resume twice after restart");
		journal.suspend(operation, "first interruption");
		appendFileSync(
			journal.path,
			`${JSON.stringify({
				schema: 1,
				type: "resume_requested",
				at: Date.now(),
				operationId: operation.id,
				sessionId: journal.sessionId,
				attempt: 2,
			})}\n${JSON.stringify({
				schema: 1,
				type: "operation_suspended",
				at: Date.now(),
				operationId: operation.id,
				sessionId: journal.sessionId,
				error: "crashed before the resumed task attempt",
			})}\n`,
		);

		const restarted = new DurableOperationJournal(journal.path, journal.sessionId);
		expect(restarted.list().at(-1)).toMatchObject({ status: "suspended", attempt: 1 });
		expect(restarted.resume().operation).toMatchObject({ attempt: 2, recovered: true });
	});

	it("atomically makes dispatched effects unresolved when an operation is suspended", () => {
		const journal = createJournal();
		const operation = journal.begin("Suspend a mutation");
		const claim = journal.claimEffect(operation, {
			...invocation("call-1"),
			toolName: "bash",
			args: { command: "deploy" },
			replay: "never",
		});
		if (claim.kind !== "execute") throw new Error("expected executable effect");

		expect(journal.suspend(operation, "provider failed")).toMatchObject({
			status: "suspended",
			effects: [{ status: "unresolved" }],
		});

		const restarted = new DurableOperationJournal(journal.path, journal.sessionId);
		expect(restarted.recoverInFlight()).toMatchObject({
			status: "suspended",
			effects: [{ status: "unresolved" }],
		});
		expect(() => restarted.markEffectReconciled(operation.id, claim.key)).not.toThrow();
	});

	it("refuses to abort suspended unresolved effects before reconciliation", () => {
		const journal = createJournal();
		const operation = journal.begin("Do not hide an uncertain deployment");
		journal.claimEffect(operation, {
			...invocation("call-1"),
			toolName: "bash",
			args: { command: "deploy" },
			replay: "never",
		});
		const suspended = journal.suspend(operation, "process interrupted");

		expect(() => journal.abortSuspended()).toThrow(/unresolved external effect/);
		journal.markEffectReconciled(operation.id, suspended.effects[0]!.key);
		expect(journal.abortSuspended()).toMatchObject({ status: "aborted" });
	});

	it("refuses every terminal outcome while an external effect is unresolved", () => {
		const journal = createJournal();
		const operation = journal.begin("Do not lose the mutation");
		journal.claimEffect(operation, {
			...invocation("call-1"),
			toolName: "bash",
			args: { command: "deploy" },
			replay: "never",
		});

		for (const outcome of ["completed", "failed", "aborted"] as const) {
			expect(() => journal.finish(operation, outcome, "interrupted observer")).toThrow(/unresolved external effect/);
		}
		expect(journal.suspend(operation, "interrupted observer")).toMatchObject({
			status: "suspended",
			effects: [{ status: "unresolved" }],
		});
	});

	it("reuses only the exact completed tool call after recovery", () => {
		const journal = createJournal();
		const operation = journal.begin("Create a release");
		const claim = journal.claimEffect(operation, {
			...invocation("call-1"),
			toolName: "bash",
			args: { command: "release" },
			replay: "never",
		});
		if (claim.kind !== "execute") throw new Error("expected executable effect");
		const result = { content: [{ type: "text", text: "released" }], details: {} };
		journal.finishEffect(operation, claim.key, "completed", result);

		const restarted = new DurableOperationJournal(journal.path, journal.sessionId);
		restarted.recoverInFlight();
		const resumed = restarted.resume().operation;
		const reused = restarted.claimEffect(resumed, {
			...invocation("call-1"),
			toolName: "bash",
			args: { command: "release" },
			replay: "never",
		});
		expect(reused).toMatchObject({ kind: "reuse", result });

		const secondOccurrence = restarted.claimEffect(resumed, {
			...invocation("call-1", "assistant-2"),
			toolName: "bash",
			args: { command: "release" },
			replay: "never",
		});
		expect(secondOccurrence.kind).toBe("execute");
	});

	it("permits a caller to re-execute the exact safe invocation after recovery", () => {
		const journal = createJournal();
		const operation = journal.begin("Read the project");
		journal.claimEffect(operation, {
			...invocation("call-1"),
			toolName: "read",
			args: { path: "README.md" },
			replay: "safe",
		});

		const restarted = new DurableOperationJournal(journal.path, journal.sessionId);
		restarted.recoverInFlight();
		const resumed = restarted.resume().operation;
		const replay = restarted.claimEffect(resumed, {
			...invocation("call-1"),
			toolName: "read",
			args: { path: "README.md" },
			replay: "safe",
		});

		expect(replay.kind).toBe("execute");
	});

	it("requires both the persisted and current declarations to permit safe replay", () => {
		const journal = createJournal();
		const operation = journal.begin("Run a custom effect");
		journal.claimEffect(operation, {
			...invocation("call-1"),
			toolName: "custom",
			args: { value: "one" },
			replay: "never",
		});

		const restarted = new DurableOperationJournal(journal.path, journal.sessionId);
		restarted.recoverInFlight();
		const resumed = restarted.resume().operation;
		expect(() =>
			restarted.claimEffect(resumed, {
				...invocation("call-1"),
				toolName: "custom",
				args: { value: "one" },
				replay: "safe",
			}),
		).toThrow(/inspect current state/);
	});

	it("rejects a reused tool call id when its tool identity changes", () => {
		const journal = createJournal();
		const operation = journal.begin("Read two files");
		journal.claimEffect(operation, {
			...invocation("call-1"),
			toolName: "read",
			args: { path: "README.md" },
			replay: "safe",
		});

		expect(() =>
			journal.claimEffect(operation, {
				...invocation("call-1"),
				toolName: "read",
				args: { path: "package.json" },
				replay: "safe",
			}),
		).toThrow(/identity mismatch/);
	});

	it("tolerates only a malformed final JSONL record", () => {
		const journal = createJournal();
		journal.begin("Read the project");
		appendFileSync(journal.path, '{"schema":1');

		const restarted = new DurableOperationJournal(journal.path, journal.sessionId);
		expect(restarted.recoverInFlight()?.status).toBe("suspended");

		appendFileSync(journal.path, '\n{"broken":true}\n{"schema":1');
		const corrupted = new DurableOperationJournal(journal.path, journal.sessionId);
		expect(() => corrupted.list()).toThrow(/Corrupt durable operation journal/);
	});

	it("normalizes a valid final record written without its newline", () => {
		const journal = createJournal();
		const operation = journal.begin("Recover the complete tail");
		writeFileSync(journal.path, readFileSync(journal.path, "utf8").trimEnd());

		const restarted = new DurableOperationJournal(journal.path, journal.sessionId);
		expect(restarted.recoverInFlight()).toMatchObject({ id: operation.id, status: "suspended" });
		expect(readFileSync(journal.path, "utf8")).toMatch(/\n$/);

		const reopened = new DurableOperationJournal(journal.path, journal.sessionId);
		expect(reopened.list().at(-1)).toMatchObject({ id: operation.id, status: "suspended" });
	});

	it("rejects a syntactically valid but invalid final record", () => {
		const journal = createJournal();
		journal.begin("Read the project");
		appendFileSync(
			journal.path,
			`${JSON.stringify({
				schema: 1,
				type: "operation_finished",
				at: Date.now(),
				operationId: "missing-outcome",
				sessionId: journal.sessionId,
			})}\n`,
		);

		const restarted = new DurableOperationJournal(journal.path, journal.sessionId);
		expect(() => restarted.list()).toThrow(/invalid durable operation record/);
	});

	it("rejects gaps and rewinds in explicit journal sequences", () => {
		const journal = createJournal();
		const operation = journal.begin("Keep total ordering");
		appendFileSync(
			journal.path,
			`${JSON.stringify({
				schema: 1,
				seq: 99,
				type: "checkpoint",
				at: Date.now(),
				operationId: operation.id,
				sessionId: journal.sessionId,
				kind: "out-of-order",
			})}\n`,
		);

		const restarted = new DurableOperationJournal(journal.path, journal.sessionId);
		expect(() => restarted.list()).toThrow(/expected sequence 3, received 99/);
	});

	it("rejects structurally valid records after a terminal operation", () => {
		const journal = createJournal();
		const operation = journal.begin("Finish once");
		journal.finish(operation, "completed");
		appendFileSync(
			journal.path,
			`${JSON.stringify({
				schema: 1,
				type: "task_attempt",
				at: Date.now(),
				operationId: operation.id,
				sessionId: journal.sessionId,
				attempt: 2,
				recovered: true,
			})}\n`,
		);

		const restarted = new DurableOperationJournal(journal.path, journal.sessionId);
		expect(() => restarted.list()).toThrow(/already finished/);
	});

	it("rejects non-consecutive task attempts", () => {
		const journal = createJournal();
		const operation = journal.begin("Attempt once");
		appendFileSync(
			journal.path,
			`${JSON.stringify({
				schema: 1,
				type: "task_attempt",
				at: Date.now(),
				operationId: operation.id,
				sessionId: journal.sessionId,
				attempt: 3,
				recovered: true,
			})}\n`,
		);

		const restarted = new DurableOperationJournal(journal.path, journal.sessionId);
		expect(() => restarted.list()).toThrow(/Invalid durable task attempt/);
	});

	it("does not truncate a malformed line that was newline-terminated", () => {
		const journal = createJournal();
		journal.begin("Keep corruption visible");
		appendFileSync(journal.path, '{"schema":1\n');

		const restarted = new DurableOperationJournal(journal.path, journal.sessionId);
		expect(() => restarted.list()).toThrow(/Corrupt durable operation journal/);
		expect(() => new DurableOperationJournal(journal.path, journal.sessionId).list()).toThrow(
			/Corrupt durable operation journal/,
		);
	});

	it("allows only one exclusive writer and releases the lease on close", () => {
		const journal = createJournal();
		const exclusive = new DurableOperationJournal(journal.path, journal.sessionId, { exclusive: true });
		expect(() => new DurableOperationJournal(journal.path, journal.sessionId, { exclusive: true })).toThrow(
			/already open/,
		);

		exclusive.close();
		const reopened = new DurableOperationJournal(journal.path, journal.sessionId, { exclusive: true });
		reopened.close();
		expect(() => reopened.begin("must stay closed")).toThrow(/journal is closed/);
	});

	it("binds a transferred writer lease to one canonical journal path", () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-durable-lease-"));
		const journalPath = join(tempDir, "session.operations.jsonl");
		const otherPath = join(tempDir, "other.operations.jsonl");
		const lease = acquireDurableOperationLease(journalPath);

		expect(() => new DurableOperationJournal(otherPath, "session-1", { lease })).toThrow(/lease path mismatch/);

		const journal = new DurableOperationJournal(journalPath, "session-1", { lease });
		expect(() => new DurableOperationJournal(journalPath, "session-1", { lease })).toThrow(/already transferred/);

		// Releasing the transfer handle after consumption must not unlock the journal.
		lease.release();
		expect(() => new DurableOperationJournal(journalPath, "session-1", { exclusive: true })).toThrow(/already open/);

		journal.close();
		const reopened = new DurableOperationJournal(journalPath, "session-1", { exclusive: true });
		reopened.close();
	});

	it("persists prepared input and requires unresolved effects to be reconciled before completion", () => {
		const journal = createJournal();
		const prepared = {
			messages: [{ role: "user", content: "original", timestamp: 1 }],
			systemPrompt: "durable system prompt",
		};
		const operation = journal.begin("Deploy", prepared);
		journal.claimEffect(operation, {
			...invocation("call-1"),
			toolName: "bash",
			args: { command: "deploy" },
			replay: "never",
		});

		const restarted = new DurableOperationJournal(journal.path, journal.sessionId);
		const suspended = restarted.recoverInFlight();
		expect(suspended?.prepared).toEqual(prepared);
		expect(() => restarted.finish(operation, "completed")).toThrow(/while suspended|unresolved external effect/);
		restarted.markEffectReconciled(operation.id, suspended!.effects[0]!.key);
		const resumed = restarted.resume().operation;
		restarted.finish(resumed, "completed");
		expect(restarted.get(resumed.id)?.status).toBe("completed");
	});
});
