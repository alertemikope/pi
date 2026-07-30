import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDurableOperationLease, DurableOperationJournal } from "../src/core/durable-operations.ts";

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

	it("suspends an interrupted operation and marks an in-flight mutation uncertain", () => {
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
		expect(suspended?.effects[0]?.status).toBe("uncertain");

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

	it("atomically makes running effects uncertain when an operation is suspended", () => {
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
			effects: [{ status: "uncertain" }],
		});

		const restarted = new DurableOperationJournal(journal.path, journal.sessionId);
		expect(restarted.recoverInFlight()).toMatchObject({
			status: "suspended",
			effects: [{ status: "uncertain" }],
		});
		expect(() => restarted.markEffectReconciled(operation.id, claim.key)).not.toThrow();
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
			effects: [{ status: "uncertain" }],
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

	it("persists prepared input and requires uncertain effects to be reconciled before completion", () => {
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
