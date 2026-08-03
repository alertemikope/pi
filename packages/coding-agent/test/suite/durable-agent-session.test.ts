import { existsSync, readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { DurableOperationJournal, durableValueFingerprint } from "../../src/core/durable-operations.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText } from "./harness.ts";

function durableJournal(session: object): DurableOperationJournal {
	const journal = (session as { _durableOperations?: DurableOperationJournal })._durableOperations;
	if (!journal) throw new Error("expected a durable operation journal");
	return journal;
}

describe("durable AgentSession integration", () => {
	it("journals a normal Pi run without replacing tools, prompt handling, or events", async () => {
		let executions = 0;
		const harness = await createHarness({
			persistentSession: true,
			initialActiveToolNames: ["mutate"],
			tools: [
				{
					name: "mutate",
					label: "Mutate",
					description: "Perform a test mutation",
					parameters: Type.Object({ value: Type.String() }),
					execute: async (_toolCallId, params) => {
						executions += 1;
						const value = (params as { value: string }).value;
						return {
							content: [{ type: "text", text: `changed:${value}` }],
							details: { value },
						};
					},
				},
			],
		});

		try {
			harness.setResponses([
				() => fauxAssistantMessage(fauxToolCall("mutate", { value: "one" }), { stopReason: "toolUse" }),
				() => fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("make the change");

			expect(executions).toBe(1);
			expect(harness.session.getLastAssistantText()).toBe("done");
			expect(harness.eventsOfType("tool_execution_end")).toHaveLength(1);
			expect(harness.session.getSuspendedOperation()).toBeUndefined();

			const journalPath = `${harness.session.sessionFile}.operations.jsonl`;
			const records = readFileSync(journalPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { type: string });
			expect(records.map((record) => record.type)).toEqual(
				expect.arrayContaining([
					"operation_started",
					"task_attempt",
					"tool_reserved",
					"tool_dispatched",
					"tool_settled",
					"checkpoint",
					"operation_finished",
				]),
			);
			expect(records[0]?.type).toBe("operation_started");
			expect(records.at(-1)?.type).toBe("operation_finished");
		} finally {
			harness.cleanup();
		}
	});

	it("keeps a custom tool named read non-replayable", async () => {
		const harness = await createHarness({
			persistentSession: true,
			initialActiveToolNames: ["read"],
			tools: [
				{
					name: "read",
					label: "Custom read",
					description: "A custom tool that must remain non-replayable",
					parameters: Type.Object({ value: Type.String() }),
					execute: async () => ({
						content: [{ type: "text", text: "custom mutation" }],
						details: {},
					}),
				},
			],
		});

		try {
			harness.setResponses([
				() => fauxAssistantMessage(fauxToolCall("read", { value: "one" }), { stopReason: "toolUse" }),
				() => fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("run the custom tool");

			const journalPath = `${harness.session.sessionFile}.operations.jsonl`;
			const records = readFileSync(journalPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { type: string; replay?: string });
			expect(records.find((record) => record.type === "tool_dispatched")?.replay).toBe("never");
		} finally {
			harness.cleanup();
		}
	});

	it("materializes the session before waiting for the first provider response", async () => {
		const harness = await createHarness({ persistentSession: true });
		let releaseResponse: (() => void) | undefined;
		const responseGate = new Promise<void>((resolve) => {
			releaseResponse = resolve;
		});
		let markProviderStarted: (() => void) | undefined;
		const providerStarted = new Promise<void>((resolve) => {
			markProviderStarted = resolve;
		});

		try {
			harness.setResponses([
				async () => {
					markProviderStarted?.();
					await responseGate;
					return fauxAssistantMessage("done");
				},
			]);

			const prompt = harness.session.prompt("survive an early crash");
			await providerStarted;

			const sessionFile = harness.session.sessionFile;
			expect(sessionFile).toBeTruthy();
			expect(existsSync(sessionFile!)).toBe(true);
			expect(existsSync(`${sessionFile}.operations.jsonl`)).toBe(true);

			const reopened = SessionManager.open(sessionFile!);
			expect(reopened.getSessionId()).toBe(harness.sessionManager.getSessionId());

			releaseResponse?.();
			await prompt;
		} finally {
			releaseResponse?.();
			harness.cleanup();
		}
	});

	it("records host verification while a durable operation is active", async () => {
		const harness = await createHarness({ persistentSession: true });
		let releaseResponse: (() => void) | undefined;
		let markStarted: (() => void) | undefined;
		const responseGate = new Promise<void>((resolve) => {
			releaseResponse = resolve;
		});
		const responseStarted = new Promise<void>((resolve) => {
			markStarted = resolve;
		});

		try {
			harness.setResponses([
				async () => {
					markStarted?.();
					await responseGate;
					return fauxAssistantMessage("done");
				},
			]);
			const prompt = harness.session.prompt("verify while running");
			await responseStarted;
			const receipt = await harness.session.runVerification({
				id: "host-check",
				command: process.execPath,
				args: ["-e", "process.stdout.write('ok')"],
			});
			releaseResponse?.();
			await prompt;

			expect(receipt.verdict).toBe("passed");
			expect(durableJournal(harness.session).list().at(-1)?.verificationReceipts).toEqual([receipt]);
		} finally {
			releaseResponse?.();
			harness.cleanup();
		}
	});

	it("runs extension-declared verification before settling", async () => {
		const harness = await createHarness({
			persistentSession: true,
			extensionFactories: [
				(pi) => {
					pi.registerVerificationCheck({
						id: "extension-check",
						command: process.execPath,
						args: ["-e", "process.stdout.write('verified')"],
					});
				},
			],
		});

		try {
			harness.setResponses([() => fauxAssistantMessage("done")]);
			await harness.session.prompt("verify automatically");

			const operation = durableJournal(harness.session).list().at(-1);
			expect(operation?.status).toBe("completed");
			expect(operation?.verificationReceipts).toEqual([
				expect.objectContaining({ criterionId: "extension-check", verdict: "passed" }),
			]);
		} finally {
			harness.cleanup();
		}
	});

	it("fails the durable operation when an extension-declared verification fails", async () => {
		const harness = await createHarness({
			persistentSession: true,
			extensionFactories: [
				(pi) => {
					pi.registerVerificationCheck({
						id: "failing-check",
						command: process.execPath,
						args: ["-e", "process.stderr.write('broken'); process.exit(2)"],
					});
				},
			],
		});

		try {
			harness.setResponses([() => fauxAssistantMessage("done")]);
			await expect(harness.session.prompt("do not claim success")).rejects.toThrow(/failing-check.*broken/s);

			const operation = durableJournal(harness.session).list().at(-1);
			expect(operation?.status).toBe("failed");
			expect(operation?.verificationReceipts).toEqual([
				expect.objectContaining({ criterionId: "failing-check", verdict: "failed" }),
			]);
		} finally {
			harness.cleanup();
		}
	});

	it("rejects a suspended prompt before extension input hooks and reports failed preflight", async () => {
		let inputEvents = 0;
		const harness = await createHarness({
			persistentSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("input", () => {
						inputEvents += 1;
					});
				},
			],
		});
		const journal = durableJournal(harness.session);
		const operation = journal.begin("interrupted request");
		journal.suspend(operation, "test interruption");
		const preflight: boolean[] = [];

		try {
			await expect(
				harness.session.prompt("must not run", {
					preflightResult: (accepted) => preflight.push(accepted),
				}),
			).rejects.toThrow(/is suspended/);
			expect(inputEvents).toBe(0);
			expect(preflight).toEqual([false]);
			expect(journal.get(operation.id)?.status).toBe("suspended");
		} finally {
			harness.cleanup();
		}
	});

	it("keeps a suspended operation retryable when recovery authentication is unavailable", async () => {
		const harness = await createHarness({ persistentSession: true, withConfiguredAuth: false });
		const journal = durableJournal(harness.session);
		const operation = journal.begin("recover after auth");
		journal.suspend(operation, "test interruption");

		try {
			await expect(harness.session.resumeSuspendedOperation()).rejects.toThrow(/No API key found/);
			expect(journal.get(operation.id)).toMatchObject({
				status: "suspended",
				attempt: 1,
			});
		} finally {
			harness.cleanup();
		}
	});

	it("restores missing prepared input before aborting a suspended operation", async () => {
		const harness = await createHarness({ persistentSession: true });
		const journal = durableJournal(harness.session);
		const preparedUser = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "prepared before interruption" }],
			timestamp: 123,
		};
		const operation = journal.begin("abort interrupted request", {
			messages: [preparedUser],
			systemPrompt: harness.session.systemPrompt,
		});
		journal.suspend(operation, "test interruption");

		try {
			expect(harness.session.abortSuspendedOperation()).toMatchObject({ status: "aborted" });
			expect(
				harness.session.messages.filter(
					(message) => message.role === "user" && getMessageText(message) === "prepared before interruption",
				),
			).toHaveLength(1);
			expect(journal.get(operation.id)).toMatchObject({ status: "aborted" });
		} finally {
			harness.cleanup();
		}
	});

	it("reconciles interrupted effects before aborting a suspended operation", async () => {
		const harness = await createHarness({ persistentSession: true });
		const journal = durableJournal(harness.session);
		const preparedUser = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "prepared before interruption" }],
			timestamp: 123,
		};
		const operation = journal.begin("abort interrupted request", {
			messages: [preparedUser],
			systemPrompt: harness.session.systemPrompt,
		});
		harness.session.agent.state.messages.push(preparedUser);
		harness.sessionManager.appendMessage(preparedUser);
		const assistant = fauxAssistantMessage(fauxToolCall("read", { path: "README.md" }), {
			stopReason: "toolUse",
		});
		const toolCall = assistant.content.find((content) => content.type === "toolCall")!;
		harness.session.agent.state.messages.push(assistant);
		const assistantEntryId = harness.sessionManager.appendMessage(assistant);
		journal.claimEffect(operation, {
			assistantEntryId,
			toolIndex: 0,
			toolCallId: toolCall.id,
			toolName: "read",
			args: { path: "README.md" },
			replay: "safe",
		});
		journal.suspend(operation, "test interruption");

		try {
			expect(harness.session.abortSuspendedOperation()).toMatchObject({ status: "aborted" });
			expect(
				harness.session.messages.filter(
					(message) => message.role === "toolResult" && message.toolCallId === toolCall.id && message.isError,
				),
			).toHaveLength(1);
			expect(journal.get(operation.id)).toMatchObject({
				status: "aborted",
				effects: [{ status: "unresolved", reconciled: true }],
			});
			harness.setResponses([() => fauxAssistantMessage("continued after abort")]);
			await harness.session.prompt("continue with new work");
			expect(harness.session.getLastAssistantText()).toBe("continued after abort");
		} finally {
			harness.cleanup();
		}
	});

	it("leaves an abort suspended when an interrupted effect cannot be reconciled", async () => {
		const harness = await createHarness({ persistentSession: true });
		const journal = durableJournal(harness.session);
		const operation = journal.begin("abort unreconcilable request");
		journal.claimEffect(operation, {
			assistantEntryId: "missing-assistant-entry",
			toolIndex: 0,
			toolCallId: "missing-call",
			toolName: "read",
			args: { path: "README.md" },
			replay: "safe",
		});
		journal.suspend(operation, "test interruption");

		try {
			expect(() => harness.session.abortSuspendedOperation()).toThrow(/originating assistant message is missing/);
			expect(journal.get(operation.id)).toMatchObject({
				status: "suspended",
				effects: [{ status: "unresolved" }],
			});
		} finally {
			harness.cleanup();
		}
	});

	it("blocks compaction and tree navigation until a suspended operation is resolved", async () => {
		const harness = await createHarness({ persistentSession: true });
		const journal = durableJournal(harness.session);
		const operation = journal.begin("interrupted request");
		journal.suspend(operation, "test interruption");

		try {
			await expect(harness.session.compact()).rejects.toThrow(/before compacting/);
			await expect(harness.session.navigateTree("missing")).rejects.toThrow(/before navigating/);
			expect(journal.get(operation.id)?.status).toBe("suspended");
		} finally {
			harness.cleanup();
		}
	});

	it("journals the final tool result after extension transformations", async () => {
		const harness = await createHarness({
			persistentSession: true,
			initialActiveToolNames: ["echo"],
			tools: [
				{
					name: "echo",
					label: "Echo",
					description: "Return a test value",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "raw" }],
						details: { stage: "raw" },
					}),
				},
			],
			extensionFactories: [
				(pi) => {
					pi.on("tool_result", () => ({
						content: [{ type: "text", text: "patched" }],
						details: { stage: "patched" },
					}));
					pi.on("message_end", (event) => {
						if (event.message.role !== "toolResult") return undefined;
						return {
							message: {
								...event.message,
								content: [{ type: "text", text: "final" }],
								details: { stage: "final" },
							},
						};
					});
				},
			],
		});

		try {
			harness.setResponses([
				() => fauxAssistantMessage(fauxToolCall("echo", {}), { stopReason: "toolUse" }),
				() => fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("echo");

			const snapshot = durableJournal(harness.session).list().at(-1);
			expect(snapshot?.effects[0]?.result).toMatchObject({
				content: [{ type: "text", text: "final" }],
				details: { stage: "final" },
			});
		} finally {
			harness.cleanup();
		}
	});

	it("persists message_end transformations in the prepared input before the provider call", async () => {
		const harness = await createHarness({
			persistentSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role !== "user") return undefined;
						return {
							message: {
								...event.message,
								content: [{ type: "text", text: "hooked input" }],
							},
						};
					});
				},
			],
		});

		try {
			harness.setResponses([() => fauxAssistantMessage("done")]);
			await harness.session.prompt("original input");

			const prepared = durableJournal(harness.session).list().at(-1)?.prepared?.messages[0];
			expect(prepared).toMatchObject({
				role: "user",
				content: [{ type: "text", text: "hooked input" }],
			});
		} finally {
			harness.cleanup();
		}
	});

	it("preserves a transformed custom message timestamp across journal and transcript persistence", async () => {
		const transformedTimestamp = 1_785_419_344_482;
		const harness = await createHarness({
			persistentSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => ({
						message: {
							customType: "durable-context",
							content: "injected context",
							display: false,
						},
					}));
					pi.on("message_end", (event) => {
						if (event.message.role !== "custom") return undefined;
						return {
							message: {
								...event.message,
								timestamp: transformedTimestamp,
							},
						};
					});
				},
			],
		});

		try {
			harness.setResponses([() => fauxAssistantMessage("done")]);
			await harness.session.prompt("use custom context");

			const prepared = durableJournal(harness.session)
				.list()
				.at(-1)
				?.prepared?.messages.find(
					(message) => !!message && typeof message === "object" && "role" in message && message.role === "custom",
				);
			const persisted = harness.sessionManager
				.buildSessionContext()
				.messages.find((message) => message.role === "custom");
			expect(prepared).toMatchObject({ role: "custom", timestamp: transformedTimestamp });
			expect(persisted).toMatchObject({ role: "custom", timestamp: transformedTimestamp });
			expect(durableValueFingerprint(prepared)).toBe(durableValueFingerprint(persisted));
		} finally {
			harness.cleanup();
		}
	});

	it("restores already-transformed prepared messages without running message hooks again", async () => {
		const harness = await createHarness({
			persistentSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role !== "user") return undefined;
						return {
							message: {
								...event.message,
								content: [{ type: "text", text: `${getMessageText(event.message)}|hook` }],
							},
						};
					});
				},
			],
		});
		const prepared = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "original|hook" }],
			timestamp: 1_785_419_344_482,
		};
		const journal = durableJournal(harness.session);
		const operation = journal.begin("original", {
			messages: [prepared],
			systemPrompt: "recovery system",
		});
		journal.suspend(operation, "test interruption");

		try {
			harness.setResponses([() => fauxAssistantMessage("recovered")]);
			await harness.session.resumeSuspendedOperation();

			const userTexts = harness.session.messages
				.filter((message) => message.role === "user")
				.map((message) => getMessageText(message));
			expect(userTexts).toContain("original|hook");
			expect(userTexts).not.toContain("original|hook|hook");
			expect(
				harness.sessionManager
					.buildSessionContext()
					.messages.filter((message) => message.role === "user" && getMessageText(message) === "original|hook"),
			).toHaveLength(1);
		} finally {
			harness.cleanup();
		}
	});

	it("blocks duplicate tool call ids before either tool executes", async () => {
		let executions = 0;
		const harness = await createHarness({
			persistentSession: true,
			initialActiveToolNames: ["echo"],
			tools: [
				{
					name: "echo",
					label: "Echo",
					description: "Count executions",
					parameters: Type.Object({ value: Type.String() }),
					execute: async () => {
						executions += 1;
						return { content: [{ type: "text", text: "executed" }], details: {} };
					},
				},
			],
		});

		try {
			harness.setResponses([
				() =>
					fauxAssistantMessage(
						[
							fauxToolCall("echo", { value: "one" }, { id: "duplicate" }),
							fauxToolCall("echo", { value: "two" }, { id: "duplicate" }),
						],
						{ stopReason: "toolUse" },
					),
			]);

			await harness.session.prompt("run both");
			expect(executions).toBe(0);
			expect(durableJournal(harness.session).list().at(-1)?.status).toBe("failed");
			expect(harness.session.messages.some((message) => message.role === "toolResult")).toBe(false);
		} finally {
			harness.cleanup();
		}
	});

	it("uses the exact later assistant occurrence when an invalid call id is reused", async () => {
		let executions = 0;
		const harness = await createHarness({
			persistentSession: true,
			initialActiveToolNames: ["echo"],
			tools: [
				{
					name: "echo",
					label: "Echo",
					description: "Require a value",
					parameters: Type.Object({ value: Type.String() }),
					execute: async (_toolCallId, params) => {
						executions += 1;
						return {
							content: [{ type: "text", text: (params as { value: string }).value }],
							details: {},
						};
					},
				},
			],
		});

		try {
			harness.setResponses([
				() => fauxAssistantMessage(fauxToolCall("echo", {}, { id: "same" }), { stopReason: "toolUse" }),
				() =>
					fauxAssistantMessage(fauxToolCall("echo", { value: "valid" }, { id: "same" }), {
						stopReason: "toolUse",
					}),
				() => fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("try again correctly");

			const assistantEntries = harness.sessionManager
				.getBranch()
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.content.some((content) => content.type === "toolCall" && content.id === "same"),
				);
			expect(executions).toBe(1);
			expect(assistantEntries).toHaveLength(2);
			expect(durableJournal(harness.session).list().at(-1)?.effects).toEqual([
				expect.objectContaining({
					assistantEntryId: assistantEntries[0]?.id,
					toolCallId: "same",
					status: "failed",
				}),
				expect.objectContaining({
					assistantEntryId: assistantEntries[1]?.id,
					toolCallId: "same",
					status: "completed",
				}),
			]);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps tool execution durable and notifies later observers when an observer throws", async () => {
		const harness = await createHarness({
			persistentSession: true,
			initialActiveToolNames: ["echo"],
			tools: [
				{
					name: "echo",
					label: "Echo",
					description: "Return a value",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "changed" }],
						details: {},
					}),
				},
			],
		});
		let laterObserverSawToolEnd = false;
		harness.session.subscribe((event) => {
			if (event.type === "tool_execution_end") {
				throw new Error("observer interrupted tool completion");
			}
		});
		harness.session.subscribe((event) => {
			if (event.type === "tool_execution_end") {
				laterObserverSawToolEnd = true;
			}
		});

		try {
			harness.setResponses([
				() => fauxAssistantMessage(fauxToolCall("echo", {}), { stopReason: "toolUse" }),
				() => fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("echo");
			expect(laterObserverSawToolEnd).toBe(true);
			expect(durableJournal(harness.session).list().at(-1)).toMatchObject({
				status: "completed",
				effects: [{ status: "completed" }],
			});
		} finally {
			harness.cleanup();
		}
	});

	it("persists prepared input and completes when observers throw", async () => {
		const harness = await createHarness({ persistentSession: true });
		let laterObserverSawUser = false;
		harness.session.subscribe(async (event) => {
			if (event.type === "message_end" && event.message.role === "user") {
				throw new Error("observer rejected user event");
			}
		});
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "user") {
				laterObserverSawUser = true;
			}
		});

		try {
			harness.setResponses([() => fauxAssistantMessage("unused")]);
			await harness.session.prompt("must survive observer failure");

			expect(
				harness.sessionManager
					.buildSessionContext()
					.messages.filter(
						(message) => message.role === "user" && getMessageText(message) === "must survive observer failure",
					),
			).toHaveLength(1);
			expect(laterObserverSawUser).toBe(true);
			expect(durableJournal(harness.session).list().at(-1)).toMatchObject({ status: "completed" });
		} finally {
			harness.cleanup();
		}
	});

	it("gives each observer a defensive copy without mutating provider, journal, or transcript input", async () => {
		const harness = await createHarness({ persistentSession: true });
		let laterObserverUserText: string | undefined;
		let providerUserText: string | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "user") {
				const text = Array.isArray(event.message.content) ? event.message.content[0] : undefined;
				if (text?.type === "text") {
					text.text = "observer-mutated";
				}
			}
		});
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "user") {
				laterObserverUserText = getMessageText(event.message);
			}
		});

		try {
			harness.setResponses([
				(context) => {
					providerUserText = getMessageText(context.messages.filter((message) => message.role === "user").at(-1));
					return fauxAssistantMessage("done");
				},
			]);
			await harness.session.prompt("original observer input");

			const operation = durableJournal(harness.session).list().at(-1);
			const sessionFile = harness.session.sessionFile;
			if (!sessionFile) throw new Error("expected a persistent session file");
			const transcript = readFileSync(sessionFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { type?: string; message?: unknown });

			expect(laterObserverUserText).toBe("original observer input");
			expect(providerUserText).toBe("original observer input");
			expect(
				harness.session.messages.some(
					(message) => message.role === "user" && getMessageText(message) === "original observer input",
				),
			).toBe(true);
			expect(
				operation?.prepared?.messages.some((message) => getMessageText(message) === "original observer input"),
			).toBe(true);
			expect(
				transcript.some(
					(entry) => entry.type === "message" && getMessageText(entry.message) === "original observer input",
				),
			).toBe(true);
			expect(
				transcript.some(
					(entry) => entry.type === "message" && getMessageText(entry.message) === "observer-mutated",
				),
			).toBe(false);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps the writer lease until an aborted in-flight tool has settled", async () => {
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let releaseTool: (() => void) | undefined;
		const toolGate = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const harness = await createHarness({
			persistentSession: true,
			initialActiveToolNames: ["slow"],
			tools: [
				{
					name: "slow",
					label: "Slow",
					description: "Ignore abort until explicitly released",
					parameters: Type.Object({}),
					execute: async () => {
						markStarted?.();
						await toolGate;
						return { content: [{ type: "text", text: "settled" }], details: {} };
					},
				},
			],
		});

		try {
			harness.setResponses([
				() => fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }),
				() => fauxAssistantMessage("done"),
			]);
			const prompt = harness.session.prompt("start");
			await started;

			harness.session.dispose();
			const journalPath = `${harness.session.sessionFile}.operations.jsonl`;
			expect(() => new DurableOperationJournal(journalPath, harness.session.sessionId, { exclusive: true })).toThrow(
				/already open/,
			);

			releaseTool?.();
			await prompt;
			await harness.session.waitForIdle();
			await Promise.resolve();

			const reopened = new DurableOperationJournal(journalPath, harness.session.sessionId, { exclusive: true });
			reopened.close();
		} finally {
			releaseTool?.();
			harness.cleanup();
		}
	});

	it("reconciles an uncertain tool call once before resuming", async () => {
		const harness = await createHarness({ persistentSession: true });
		const journal = durableJournal(harness.session);
		const originalUser = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "deploy once" }],
			timestamp: 1,
		};
		const assistant = fauxAssistantMessage(fauxToolCall("bash", { command: "deploy" }), {
			stopReason: "toolUse",
		});
		const toolIndex = assistant.content.findIndex((content) => content.type === "toolCall");
		const toolCall = assistant.content[toolIndex];
		if (!toolCall || toolCall.type !== "toolCall") throw new Error("expected a tool call");
		const toolCallId = toolCall.id;
		harness.session.agent.state.messages.push(originalUser);
		harness.sessionManager.appendMessage(originalUser);
		harness.session.agent.state.messages.push(assistant);
		const assistantEntryId = harness.sessionManager.appendMessage(assistant);
		const operation = journal.begin("deploy once", {
			messages: [originalUser],
			systemPrompt: "recovery system",
		});
		journal.claimEffect(operation, {
			assistantEntryId,
			toolIndex,
			toolCallId,
			toolName: "bash",
			args: { command: "deploy" },
			replay: "never",
		});
		journal.recoverInFlight();

		try {
			harness.setResponses([() => fauxAssistantMessage("recovered")]);
			await harness.session.resumeSuspendedOperation();

			const matchingResults = harness.session.messages.filter(
				(message) => message.role === "toolResult" && message.toolCallId === toolCallId,
			);
			const originalInputs = harness.session.messages.filter(
				(message) => message.role === "user" && getMessageText(message) === "deploy once",
			);
			expect(originalInputs).toHaveLength(1);
			expect(matchingResults).toHaveLength(1);
			expect(matchingResults[0]).toMatchObject({ isError: true, toolName: "bash" });
			expect(journal.get(operation.id)).toMatchObject({ status: "completed", attempt: 2 });
			expect(journal.get(operation.id)?.effects[0]?.reconciled).toBe(true);
		} finally {
			harness.cleanup();
		}
	});
});
