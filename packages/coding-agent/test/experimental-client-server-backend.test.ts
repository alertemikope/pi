import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { PiClient } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import type { TranscriptProgress } from "@earendil-works/pi-protocol";
import { PiServer, PiServerError } from "@earendil-works/pi-server";
import { describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ExperimentalPiSessionBackend } from "../src/experimental/client-server/backend.ts";
import { ExperimentalClientController } from "../src/experimental/client-server/client-controller.ts";

async function createFixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-experimental-backend-"));
	const cwd = join(root, "workspace");
	await mkdir(cwd);
	const faux = fauxProvider({
		provider: `faux-${randomUUID()}`,
		models: [
			{ id: "faux-reasoning", name: "Faux Reasoning", reasoning: true },
			{ id: "faux-plain", name: "Faux Plain", reasoning: false },
		],
		tokensPerSecond: 100,
		tokenSize: { min: 2, max: 3 },
	});
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.refresh({ allowNetwork: false });
	const settingsManager = SettingsManager.inMemory({
		defaultProvider: faux.provider.id,
		defaultModel: "faux-reasoning",
		defaultThinkingLevel: "high",
		transport: "sse",
		retry: { provider: { timeoutMs: 5_000, maxRetries: 0, maxRetryDelayMs: 100 } },
	});
	const backend = await ExperimentalPiSessionBackend.create({
		defaultCwd: cwd,
		sessionRoot: join(root, "sessions"),
		modelRuntime,
		settingsManager,
	});
	return { root, cwd, faux, modelRuntime, settingsManager, backend };
}

describe("experimental AgentHarness server backend", () => {
	test("normalizes snapshots, restores model/thinking, and holds an exclusive session lock", async () => {
		const fixture = await createFixture();
		let runtime = await fixture.backend.createSession({
			id: "server-session-1",
			cwd: fixture.cwd,
			name: "Backend test",
			model: { provider: fixture.faux.provider.id, id: "faux-reasoning" },
			thinkingLevel: "high",
		});
		try {
			const initial = await runtime.snapshot();
			expect(initial).toMatchObject({
				id: "server-session-1",
				name: "Backend test",
				cwd: fixture.cwd,
				phase: "idle",
				model: { provider: fixture.faux.provider.id, id: "faux-reasoning" },
				thinkingLevel: "high",
				revision: 0,
				transcript: [],
				locked: true,
			});

			const models = await fixture.backend.listModels();
			expect(models).toContainEqual(
				expect.objectContaining({
					provider: fixture.faux.provider.id,
					id: "faux-reasoning",
					authenticated: true,
					supportedThinkingLevels: expect.arrayContaining(["off", "high"]),
				}),
			);
			const summaries = await fixture.backend.listSessions();
			expect(summaries).toContainEqual(
				expect.objectContaining({ id: "server-session-1", name: "Backend test", locked: true }),
			);

			const secondBackend = await ExperimentalPiSessionBackend.create({
				defaultCwd: fixture.cwd,
				sessionRoot: join(fixture.root, "sessions"),
				modelRuntime: fixture.modelRuntime,
				settingsManager: fixture.settingsManager,
			});
			await expect(secondBackend.openSession("server-session-1")).rejects.toMatchObject({
				code: "session_locked",
			});

			fixture.faux.setResponses([fauxAssistantMessage("normalized response")]);
			const progress: TranscriptProgress[] = [];
			runtime.subscribe(() => {
				throw new Error("network subscriber failed");
			});
			runtime.subscribe((event) => {
				if (event.type === "progress") progress.push(event.progress);
			});
			await runtime.prompt({ text: "hello" });
			const completed = await runtime.snapshot();
			expect(completed.revision).toBeGreaterThan(initial.revision);
			expect(completed.phase).toBe("idle");
			expect(completed.transcript.map((item) => item.role)).toEqual(["user", "assistant"]);
			expect(completed.transcript[1]).toMatchObject({
				role: "assistant",
				content: [{ type: "text", text: "normalized response" }],
				status: "complete",
				stopReason: "stop",
			});
			expect(completed.transcript.some((item) => "parentId" in item)).toBe(false);
			expect(progress.some((event) => event.type === "assistant_delta")).toBe(true);

			await runtime.setModel({ provider: fixture.faux.provider.id, id: "faux-plain" });
			expect(await runtime.snapshot()).toMatchObject({
				model: { provider: fixture.faux.provider.id, id: "faux-plain" },
				thinkingLevel: "off",
			});
			await runtime.setModel({ provider: fixture.faux.provider.id, id: "faux-reasoning" });
			await runtime.setThinking("high");

			await runtime.dispose();
			runtime = await secondBackend.openSession("server-session-1");
			const restored = await runtime.snapshot();
			expect(restored.model).toEqual(initial.model);
			expect(restored.thinkingLevel).toBe("high");
			expect(restored.transcript).toEqual(completed.transcript);
		} finally {
			await runtime.dispose();
			await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		}
	});

	test("applies server-only defaults to newly created sessions", async () => {
		const fixture = await createFixture();
		fixture.backend.setDefaultSessionOptions({
			model: { provider: fixture.faux.provider.id, id: "faux-plain" },
			thinkingLevel: "off",
		});
		const runtime = await fixture.backend.createSession({ id: "server-defaults", cwd: fixture.cwd });
		try {
			expect(await runtime.snapshot()).toMatchObject({
				model: { provider: fixture.faux.provider.id, id: "faux-plain" },
				thinkingLevel: "off",
			});
		} finally {
			await runtime.dispose();
			await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		}
	});

	test("exposes accepted steering text to every session snapshot", async () => {
		const fixture = await createFixture();
		const runtime = await fixture.backend.createSession({
			id: "server-visible-steer",
			cwd: fixture.cwd,
			model: { provider: fixture.faux.provider.id, id: "faux-reasoning" },
		});
		try {
			fixture.faux.setResponses([fauxAssistantMessage("long response ".repeat(1_000))]);
			let resolveTurn: (() => void) | undefined;
			const turnStarted = new Promise<void>((resolvePromise) => {
				resolveTurn = resolvePromise;
			});
			const unsubscribe = runtime.subscribe((event) => {
				if (event.type !== "snapshot") return;
				void Promise.resolve(runtime.snapshot()).then((snapshot) => {
					if (snapshot.phase === "turn") resolveTurn?.();
				});
			});
			const prompt = runtime.prompt({ text: "start" });
			await turnStarted;
			await runtime.steer({ text: "adjust the approach" });
			expect(await runtime.snapshot()).toMatchObject({
				queuedSteerCount: 1,
				queuedSteer: [{ role: "user", content: [{ type: "text", text: "adjust the approach" }] }],
			});
			await runtime.abort();
			await prompt;
			unsubscribe();
		} finally {
			await runtime.dispose();
			await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		}
	});

	test("rejects concurrent structural mutations instead of queueing them", async () => {
		const fixture = await createFixture();
		const runtime = await fixture.backend.createSession({
			id: "server-concurrent-mutation",
			cwd: fixture.cwd,
			model: { provider: fixture.faux.provider.id, id: "faux-reasoning" },
		});
		try {
			const changingModel = runtime.setModel({ provider: fixture.faux.provider.id, id: "faux-plain" });
			await expect(runtime.setThinking("medium")).rejects.toMatchObject({ code: "busy" });
			await expect(runtime.prompt({ text: "must not queue" })).rejects.toMatchObject({ code: "busy" });
			await changingModel;
		} finally {
			await runtime.dispose();
			await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		}
	});

	test("streams live bash output and keeps runtime revisions monotonic", async () => {
		const fixture = await createFixture();
		const runtime = await fixture.backend.createSession({
			id: "server-session-bash",
			cwd: fixture.cwd,
			model: { provider: fixture.faux.provider.id, id: "faux-reasoning" },
			thinkingLevel: "low",
		});
		try {
			fixture.faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall("bash", { command: "printf first; sleep 0.2; printf second" }, { id: "bash-call" }),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			const progress: TranscriptProgress[] = [];
			const revisionReads: Array<Promise<number>> = [];
			runtime.subscribe((event) => {
				if (event.type === "progress") progress.push(event.progress);
				if (event.type === "snapshot") {
					revisionReads.push(Promise.resolve(runtime.snapshot()).then((snapshot) => snapshot.revision));
				}
			});
			await runtime.prompt({ text: "run it" });
			const revisions = await Promise.all(revisionReads);
			expect(revisions.length).toBeGreaterThan(2);
			expect(revisions).toEqual([...revisions].sort((left, right) => left - right));

			const toolUpdates = progress.filter(
				(event): event is Extract<TranscriptProgress, { type: "item_updated" }> =>
					event.type === "item_updated" && event.item.role === "tool",
			);
			expect(
				toolUpdates.some((event) =>
					event.item.content.some((part) => part.type === "text" && part.text.includes("first")),
				),
			).toBe(true);
			const final = await runtime.snapshot();
			expect(final.transcript.map((item) => item.role)).toEqual(["user", "assistant", "tool", "assistant"]);
			const tool = final.transcript.find((item) => item.role === "tool");
			expect(tool).toMatchObject({
				toolCallId: "bash-call",
				toolName: "bash",
				input: { command: "printf first; sleep 0.2; printf second" },
				status: "complete",
				isError: false,
			});
		} finally {
			await runtime.dispose();
			await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		}
	});

	test("works through a real PiServer and PiClient Unix transport", async () => {
		const fixture = await createFixture();
		const token = "transport-secret";
		const socketPath = join(fixture.root, "server.sock");
		const server = new PiServer(fixture.backend, { token, unix: { path: socketPath } });
		await server.start();
		const client = new PiClient({
			token,
			transportFactory: createUnixTransportFactory({ path: socketPath }),
		});
		try {
			const serverSnapshot = await client.connect();
			expect(serverSnapshot.models).toContainEqual(
				expect.objectContaining({ provider: fixture.faux.provider.id, id: "faux-reasoning" }),
			);
			const session = await client.createSession({
				cwd: fixture.cwd,
				model: { provider: fixture.faux.provider.id, id: "faux-reasoning" },
				thinkingLevel: "medium",
			});
			expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
			const controller = new ExperimentalClientController(client);
			await controller.attachInitial(session);
			fixture.faux.setResponses([fauxAssistantMessage("over unix")]);
			const progress: TranscriptProgress[] = [];
			const unsubscribe = session.onEvent((event) => {
				if (event.type === "session_progress") progress.push(event.progress);
			});
			await controller.submit("transport prompt");
			unsubscribe();
			expect(session.snapshot?.phase).toBe("idle");
			expect(session.snapshot?.transcript.at(-1)).toMatchObject({
				role: "assistant",
				content: [{ type: "text", text: "over unix" }],
			});
			expect(progress.some((event) => event.type === "assistant_delta")).toBe(true);
			const previousId = session.id;
			await controller.createAndSwitch({
				cwd: fixture.cwd,
				model: { provider: fixture.faux.provider.id, id: "faux-reasoning" },
				thinkingLevel: "medium",
			});
			expect(controller.session?.id).not.toBe(previousId);
			expect(client.isSessionAttached(previousId)).toBe(false);
			const reopened = await fixture.backend.openSession(previousId);
			await reopened.dispose();
			await controller.dispose();
		} finally {
			client.disconnect();
			await server.close();
			await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		}
	});

	test("maps unsupported model and thinking requests to protocol-safe errors", async () => {
		const fixture = await createFixture();
		try {
			await expect(
				fixture.backend.createSession({
					id: "bad-model",
					cwd: fixture.cwd,
					model: { provider: "missing", id: "missing" },
				}),
			).rejects.toBeInstanceOf(PiServerError);
			await expect(
				fixture.backend.createSession({
					id: "bad-thinking",
					cwd: fixture.cwd,
					model: { provider: fixture.faux.provider.id, id: "faux-reasoning" },
					thinkingLevel: "max",
				}),
			).rejects.toMatchObject({ code: "invalid_request" });
		} finally {
			await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		}
	});
});
