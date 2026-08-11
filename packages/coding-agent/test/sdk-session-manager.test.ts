import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireDurableOperationLease, DurableOperationJournal } from "../src/core/durable-operations.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("createAgentSession session manager defaults", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses agentDir for the default persisted session path", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
		});

		const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		const expectedSessionDir = join(agentDir, "sessions", safePath);
		const sessionDir = session.sessionManager.getSessionDir();
		const sessionFile = session.sessionManager.getSessionFile();

		expect(sessionDir).toBe(expectedSessionDir);
		expect(sessionFile?.startsWith(`${expectedSessionDir}/`)).toBe(true);

		session.dispose();
	});

	it("keeps an explicit sessionManager override", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.sessionManager.isPersisted()).toBe(false);

		session.dispose();
	});

	it("uses an injected durable operation store as the sole operation authority", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionManager = SessionManager.create(cwd, join(tempDir, "sessions"));
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session path");
		const customJournalPath = join(tempDir, "custom-operation-store.jsonl");
		const store = new DurableOperationJournal(customJournalPath, sessionManager.getSessionId());
		store.begin("Recover through the injected store");
		const thread = store.begin("Recover a second lane", undefined, { lane: "thread:42" });
		store.claimEffect(thread, {
			assistantEntryId: "assistant-thread",
			toolIndex: 0,
			toolCallId: "call-thread",
			toolName: "bash",
			args: { command: "deploy" },
			replay: "never",
		});

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			sessionManager,
			durableOperationStore: store,
		});

		expect(session.getSuspendedOperation()).toMatchObject({
			lane: "main",
			kind: "run",
			status: "suspended",
		});
		expect(existsSync(customJournalPath)).toBe(true);
		expect(existsSync(`${sessionFile}.operations.jsonl`)).toBe(false);
		expect(store.get(thread.id)).toMatchObject({
			lane: "thread:42",
			status: "suspended",
			effects: [{ status: "unresolved" }],
		});
		expect(() => acquireDurableOperationLease(`${sessionFile}.operations.jsonl`)).toThrow(/already open/);

		session.dispose();
		const releasedLease = acquireDurableOperationLease(`${sessionFile}.operations.jsonl`);
		releasedLease.release();
	});

	it("closes an injected store when the transcript writer lease is unavailable", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionManager = SessionManager.create(cwd, join(tempDir, "sessions"));
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session path");
		const blockingLease = acquireDurableOperationLease(`${sessionFile}.operations.jsonl`);
		const store = new DurableOperationJournal(
			join(tempDir, "rejected-custom-operation-store.jsonl"),
			sessionManager.getSessionId(),
		);

		try {
			await expect(
				createAgentSession({
					cwd,
					agentDir,
					model: model!,
					sessionManager,
					durableOperationStore: store,
				}),
			).rejects.toThrow(/already open/);
			expect(() => store.begin("Must not run")).toThrow(/closed/);
		} finally {
			blockingLease.release();
		}
	});

	it("releases the pre-acquired lease when the session path changes during initialization", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionDir = join(tempDir, "sessions");
		const sessionManager = SessionManager.create(cwd, sessionDir);
		const originalGetSessionFile = sessionManager.getSessionFile.bind(sessionManager);
		const originalSessionFile = originalGetSessionFile();
		if (!originalSessionFile) throw new Error("Expected a persisted session path");
		const movedSessionFile = join(sessionDir, "moved.jsonl");
		let getSessionFileCalls = 0;
		sessionManager.getSessionFile = () => {
			getSessionFileCalls += 1;
			if (getSessionFileCalls === 2) {
				sessionManager.setSessionFile(movedSessionFile);
			}
			return originalGetSessionFile();
		};

		await expect(
			createAgentSession({
				cwd,
				agentDir,
				model: model!,
				sessionManager,
			}),
		).rejects.toThrow(/Session changed while acquiring its durable writer lease/);

		const journal = new DurableOperationJournal(`${originalSessionFile}.operations.jsonl`, "probe", {
			exclusive: true,
		});
		journal.close();
	});

	it("derives cwd from an explicit sessionManager when cwd is omitted", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionCwd = join(tempDir, "session-project");
		mkdirSync(sessionCwd, { recursive: true });
		const sessionManager = SessionManager.inMemory(sessionCwd);
		const { session } = await createAgentSession({
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.systemPrompt).toContain(`Current working directory: ${sessionCwd}`);

		const bashTool = session.agent.state.tools.find((tool) => tool.name === "bash");
		expect(bashTool).toBeTruthy();
		const result = await bashTool!.execute("test", { command: "pwd" });
		const output = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");

		expect(realpathSync(output.trim())).toBe(realpathSync(sessionCwd));

		session.dispose();
	});

	it("exposes current session state to the built-in bash tool", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			thinkingLevel: "high",
		});
		expect(session.sessionFile).toBeTruthy();
		expect(session.systemPrompt).toContain(
			"You can inspect PI_* environment variables for current model and session details.",
		);

		const bashTool = session.agent.state.tools.find((tool) => tool.name === "bash");
		expect(bashTool).toBeTruthy();
		const result = await bashTool!.execute("test", {
			command: `printf '%s\\n' "$PI_SESSION_ID" "$PI_SESSION_FILE" "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL"`,
		});
		const output = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");

		expect(output.trim().split("\n")).toEqual([
			session.sessionId,
			session.sessionFile,
			model!.provider,
			model!.id,
			session.thinkingLevel,
		]);

		session.dispose();
	});
});
