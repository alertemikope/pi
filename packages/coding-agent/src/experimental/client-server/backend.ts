import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
	AgentHarness,
	AgentHarnessError,
	type AgentHarnessEvent,
	type AgentHarnessPhase,
	type AgentHarnessTool,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type ExecutionToolContext,
	type JsonlSessionMetadata,
	JsonlSessionRepo,
	type Session,
	SessionError,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import type {
	JsonValue,
	ModelMetadata,
	ModelRef,
	SessionPhase,
	SessionSnapshot,
	SessionSummary,
	ThinkingLevel,
	ToolTranscriptItem,
	TranscriptItem,
	TranscriptProgress,
} from "@earendil-works/pi-protocol";
import {
	type CreateSessionOptions,
	PiServerError,
	type PiSessionBackend,
	type PiSessionRuntime,
	type PiSessionRuntimeEvent,
	type PromptInput,
	type SteerInput,
} from "@earendil-works/pi-server";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../../config.ts";
import { DEFAULT_THINKING_LEVEL } from "../../core/defaults.ts";
import { ModelRuntime } from "../../core/model-runtime.ts";
import { mergeProviderAttributionHeaders } from "../../core/provider-attribution.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { buildSystemPrompt } from "../../core/system-prompt.ts";
import {
	getFullActiveBranch,
	isAssistantMessage,
	isToolResultMessage,
	isUserMessage,
	mergeLiveTranscript,
	normalizeAssistantMessage,
	normalizeBranchTranscript,
	normalizedMessageId,
	normalizeModelMetadata,
	normalizeToolMessage,
	normalizeUsage,
	normalizeUserMessage,
	readStoredSessionState,
	toJsonValue,
} from "./normalization.ts";

const DEFAULT_SESSION_ROOT_NAME = "experimental-server-sessions";
const TOOL_NAMES = ["read", "bash", "edit", "write"] as const;
const TOOL_SNIPPETS: Record<(typeof TOOL_NAMES)[number], string> = {
	read: "Read file contents",
	bash: "Execute bash commands (ls, grep, find, etc.)",
	edit: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
	write: "Create or overwrite files",
};
const TOOL_GUIDELINES = [
	"Inspect PI_* environment variables for current model and session details.",
	"Use read to examine files instead of cat or sed.",
	"Use edit for precise changes (edits[].oldText must match exactly)",
	"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
	"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
	"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
	"Use write only for new files or complete rewrites.",
];

export interface ExperimentalPiSessionBackendOptions {
	agentDir?: string;
	sessionRoot?: string;
	defaultCwd?: string;
	modelRuntime?: ModelRuntime;
	settingsManager?: SettingsManager;
}

interface AcquiredLock {
	compromisedError(): Error | undefined;
	onCompromised(listener: (error: Error) => void): () => void;
	release(): Promise<void>;
}

interface ToolProgressResult {
	content: ToolTranscriptItem["content"];
	details?: JsonValue;
	usage?: ToolTranscriptItem["usage"];
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

function toPiServerError(error: unknown): Error {
	if (error instanceof PiServerError) return error;
	if (error instanceof AgentHarnessError) {
		if (error.code === "busy") return new PiServerError("busy", error.message);
		if (error.code === "invalid_argument") return new PiServerError("invalid_request", error.message);
		if (error.code === "session" && error.cause instanceof SessionError && error.cause.code === "not_found") {
			return new PiServerError("not_found", error.message);
		}
	}
	if (error instanceof SessionError && error.code === "not_found") {
		return new PiServerError("not_found", error.message);
	}
	return error instanceof Error ? error : new Error(String(error));
}

function parseCreatedAt(value: string): number {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function isDirectoryInfo(result: Awaited<ReturnType<NodeExecutionEnv["fileInfo"]>>): boolean {
	return result.ok && result.value.kind === "directory";
}

function normalizeToolProgressResult(value: unknown): ToolProgressResult {
	if (typeof value !== "object" || value === null) return { content: [] };
	const source = value as { content?: unknown; details?: unknown; usage?: unknown };
	const content: ToolTranscriptItem["content"] = [];
	if (Array.isArray(source.content)) {
		for (const part of source.content) {
			if (typeof part !== "object" || part === null || !("type" in part)) continue;
			const candidate = part as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
			if (candidate.type === "text" && typeof candidate.text === "string") {
				content.push({ type: "text", text: candidate.text });
			} else if (
				candidate.type === "image" &&
				typeof candidate.data === "string" &&
				typeof candidate.mimeType === "string" &&
				candidate.mimeType
			) {
				content.push({ type: "image", data: candidate.data, mimeType: candidate.mimeType });
			}
		}
	}
	const details = toJsonValue(source.details);
	const usage = normalizeUsage(source.usage as Parameters<typeof normalizeUsage>[0]);
	return {
		content,
		...(details === undefined ? {} : { details }),
		...(usage === undefined ? {} : { usage }),
	};
}

export class ExperimentalPiSessionBackend implements PiSessionBackend {
	readonly modelRuntime: ModelRuntime;
	readonly settingsManager: SettingsManager;
	readonly sessionRoot: string;

	private readonly defaultCwd: string;
	private readonly storageEnv: NodeExecutionEnv;
	private readonly repo: JsonlSessionRepo;
	private readonly lockRoot: string;
	private defaultModel: ModelRef | undefined;
	private defaultThinkingLevel: ThinkingLevel | undefined;

	private constructor(options: {
		modelRuntime: ModelRuntime;
		settingsManager: SettingsManager;
		sessionRoot: string;
		defaultCwd: string;
	}) {
		this.modelRuntime = options.modelRuntime;
		this.settingsManager = options.settingsManager;
		this.sessionRoot = options.sessionRoot;
		this.defaultCwd = options.defaultCwd;
		this.lockRoot = join(this.sessionRoot, ".locks");
		this.storageEnv = new NodeExecutionEnv({ cwd: this.defaultCwd });
		this.repo = new JsonlSessionRepo({ fs: this.storageEnv, sessionsRoot: this.sessionRoot });
	}

	static async create(options: ExperimentalPiSessionBackendOptions = {}): Promise<ExperimentalPiSessionBackend> {
		const agentDir = resolve(options.agentDir ?? getAgentDir());
		const defaultCwd = resolve(options.defaultCwd ?? process.cwd());
		const settingsSource =
			options.settingsManager ?? SettingsManager.create(defaultCwd, agentDir, { projectTrusted: false });
		const settingsManager = SettingsManager.inMemory(settingsSource.getGlobalSettings(), { projectTrusted: false });
		const modelRuntime =
			options.modelRuntime ??
			(await ModelRuntime.create({
				authPath: join(agentDir, "auth.json"),
				modelsPath: join(agentDir, "models.json"),
				allowModelNetwork: false,
			}));
		await modelRuntime.getAvailable();
		const sessionRoot = resolve(options.sessionRoot ?? join(agentDir, DEFAULT_SESSION_ROOT_NAME));
		const backend = new ExperimentalPiSessionBackend({ modelRuntime, settingsManager, sessionRoot, defaultCwd });
		await backend.validateCwd(defaultCwd);
		await mkdir(backend.lockRoot, { recursive: true, mode: 0o700 });
		return backend;
	}

	setDefaultSessionOptions(options: { model?: ModelRef; thinkingLevel?: ThinkingLevel }): void {
		this.defaultModel = options.model;
		this.defaultThinkingLevel = options.thinkingLevel;
	}

	async listModels(): Promise<ModelMetadata[]> {
		await this.modelRuntime.getAvailable();
		return this.modelRuntime
			.getModels()
			.map((model) => normalizeModelMetadata(model, this.modelRuntime.hasConfiguredAuth(model.provider)));
	}

	async listSessions(): Promise<SessionSummary[]> {
		const metadata = await this.repo.list();
		return Promise.all(
			metadata.map(async (entry): Promise<SessionSummary> => {
				try {
					const session = await this.repo.open(entry);
					const branch = await getFullActiveBranch(session);
					const createdAt = parseCreatedAt(entry.createdAt);
					const state = readStoredSessionState(branch, createdAt);
					if (!state.model) throw new Error("stored session has no model");
					if (state.invalidThinkingLevel !== undefined) {
						throw new Error(`stored session has invalid thinking level: ${state.invalidThinkingLevel}`);
					}
					return {
						id: entry.id,
						name: state.name,
						cwd: entry.cwd,
						createdAt,
						updatedAt: state.updatedAt,
						phase: "idle",
						model: state.model,
						thinkingLevel: state.thinkingLevel ?? "off",
						attached: false,
						locked: await this.isLocked(entry.id),
					};
				} catch (error) {
					throw new Error(`Failed to read experimental session ${entry.id}`, { cause: error });
				}
			}),
		);
	}

	async createSession(options: CreateSessionOptions): Promise<PiSessionRuntime> {
		const cwd = options.cwd ?? this.defaultCwd;
		await this.validateCwd(cwd);
		const model = await this.resolveModel(options.model);
		const thinkingLevel = this.resolveThinkingLevel(model, options.thinkingLevel, true);
		const acquired = await this.acquireLock(options.id);
		try {
			if ((await this.findMetadata(options.id)) !== undefined) {
				throw new PiServerError("invalid_request", `Session already exists: ${options.id}`);
			}
			const session = await this.repo.create({ cwd, id: options.id });
			await session.appendModelChange(model.provider, model.id);
			await session.appendThinkingLevelChange(thinkingLevel);
			if (options.name !== undefined) await session.appendSessionName(options.name);
			return await this.createRuntime(session, model, thinkingLevel, acquired);
		} catch (error) {
			await acquired.release();
			throw toPiServerError(error);
		}
	}

	async openSession(sessionId: string): Promise<PiSessionRuntime> {
		const metadata = await this.findMetadata(sessionId);
		if (!metadata) throw new PiServerError("not_found", `Session was not found: ${sessionId}`);
		const acquired = await this.acquireLock(sessionId);
		try {
			const session = await this.repo.open(metadata);
			const branch = await getFullActiveBranch(session);
			const state = readStoredSessionState(branch, parseCreatedAt(metadata.createdAt));
			if (!state.model) throw new PiServerError("invalid_request", `Session ${sessionId} has no saved model`);
			if (state.invalidThinkingLevel !== undefined) {
				throw new PiServerError(
					"invalid_request",
					`Session ${sessionId} has invalid thinking level: ${state.invalidThinkingLevel}`,
				);
			}
			const model = await this.resolveModel(state.model);
			const thinkingLevel = this.resolveThinkingLevel(model, state.thinkingLevel, true);
			return await this.createRuntime(session, model, thinkingLevel, acquired);
		} catch (error) {
			await acquired.release();
			throw toPiServerError(error);
		}
	}

	private async validateCwd(cwd: string): Promise<void> {
		if (!isAbsolute(cwd)) throw new PiServerError("invalid_request", `Session cwd must be absolute: ${cwd}`);
		const env = new NodeExecutionEnv({ cwd });
		try {
			const info = await env.fileInfo(cwd);
			if (!isDirectoryInfo(info)) {
				const suffix = info.ok ? "is not a directory" : info.error.message;
				throw new PiServerError("invalid_request", `Invalid session cwd ${cwd}: ${suffix}`);
			}
		} finally {
			await env.cleanup();
		}
	}

	private async resolveModel(reference?: ModelRef): Promise<Model<Api>> {
		await this.modelRuntime.getAvailable();
		const requested = reference ?? this.defaultModel;
		let model: Model<Api> | undefined;
		if (requested) model = this.modelRuntime.getModel(requested.provider, requested.id);
		if (!model) {
			const defaultProvider = this.settingsManager.getDefaultProvider();
			const defaultModel = this.settingsManager.getDefaultModel();
			if (!requested && defaultProvider && defaultModel) {
				const configuredDefault = this.modelRuntime.getModel(defaultProvider, defaultModel);
				if (configuredDefault && this.modelRuntime.hasConfiguredAuth(configuredDefault.provider)) {
					model = configuredDefault;
				}
			}
		}
		if (!model && !requested) model = this.modelRuntime.getAvailableSnapshot()[0];
		if (!model) {
			const label = requested ? `${requested.provider}/${requested.id}` : "a default model";
			throw new PiServerError("invalid_request", `Could not resolve ${label}`);
		}
		if (!this.modelRuntime.hasConfiguredAuth(model.provider)) {
			throw new PiServerError("invalid_request", `Model is not authenticated: ${model.provider}/${model.id}`);
		}
		return model;
	}

	private resolveThinkingLevel(
		model: Model<Api>,
		requested: ThinkingLevel | undefined,
		validateRequested: boolean,
	): ThinkingLevel {
		const fallback =
			this.defaultThinkingLevel ?? this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
		const level = requested ?? fallback;
		const clamped = clampThinkingLevel(model, level);
		if (validateRequested && requested !== undefined && clamped !== requested) {
			throw new PiServerError(
				"invalid_request",
				`Thinking level ${requested} is not supported by ${model.provider}/${model.id}`,
			);
		}
		return clamped;
	}

	private async createRuntime(
		session: Session,
		model: Model<Api>,
		thinkingLevel: ThinkingLevel,
		acquired: AcquiredLock,
	): Promise<ExperimentalPiSessionRuntime> {
		const providerRetry = this.settingsManager.getProviderRetrySettings();
		const httpIdleTimeoutMs = this.settingsManager.getHttpIdleTimeoutMs();
		const timeoutMs = providerRetry.timeoutMs ?? (httpIdleTimeoutMs === 0 ? 2_147_483_647 : httpIdleTimeoutMs);
		const metadata = await session.getMetadata();
		if (!("cwd" in metadata) || typeof metadata.cwd !== "string") {
			throw new PiServerError("invalid_request", "Session metadata is missing cwd");
		}
		const env = new NodeExecutionEnv({
			cwd: metadata.cwd,
			shellPath: this.settingsManager.getShellPath(),
		});
		return new ExperimentalPiSessionRuntime({
			session,
			modelRuntime: this.modelRuntime,
			settingsManager: this.settingsManager,
			model,
			thinkingLevel,
			env,
			acquired,
			streamOptions: {
				transport: this.settingsManager.getTransport(),
				timeoutMs,
				maxRetries: providerRetry.maxRetries,
				maxRetryDelayMs: providerRetry.maxRetryDelayMs,
			},
		});
	}

	private async findMetadata(sessionId: string): Promise<JsonlSessionMetadata | undefined> {
		return (await this.repo.list()).find((entry) => entry.id === sessionId);
	}

	private lockTarget(sessionId: string): string {
		const digest = createHash("sha256").update(sessionId, "utf8").digest("hex");
		return join(this.lockRoot, digest);
	}

	private async ensureLockTarget(sessionId: string): Promise<string> {
		await mkdir(this.lockRoot, { recursive: true, mode: 0o700 });
		const target = this.lockTarget(sessionId);
		await writeFile(target, "", { flag: "a", mode: 0o600 });
		return target;
	}

	private async isLocked(sessionId: string): Promise<boolean> {
		return lockfile.check(await this.ensureLockTarget(sessionId), { realpath: false, stale: 30_000 });
	}

	private async acquireLock(sessionId: string): Promise<AcquiredLock> {
		const target = await this.ensureLockTarget(sessionId);
		let compromised: Error | undefined;
		const compromiseListeners = new Set<(error: Error) => void>();
		let release: (() => Promise<void>) | undefined;
		try {
			release = await lockfile.lock(target, {
				realpath: false,
				stale: 30_000,
				update: 10_000,
				retries: 0,
				onCompromised: (error) => {
					compromised = error;
					for (const listener of compromiseListeners) listener(error);
				},
			});
		} catch (error) {
			if (errorCode(error) === "ELOCKED") {
				throw new PiServerError("session_locked", `Session is locked: ${sessionId}`);
			}
			throw error;
		}
		let released = false;
		let releasing: Promise<void> | undefined;
		return {
			compromisedError: () => compromised,
			onCompromised: (listener) => {
				compromiseListeners.add(listener);
				if (compromised) listener(compromised);
				return () => compromiseListeners.delete(listener);
			},
			release: async () => {
				if (released) return;
				if (compromised) {
					released = true;
					compromiseListeners.clear();
					return;
				}
				if (releasing) return releasing;
				const current = (async () => {
					await release?.();
					released = true;
					compromiseListeners.clear();
				})();
				releasing = current;
				try {
					await current;
				} finally {
					if (!released && releasing === current) releasing = undefined;
				}
			},
		};
	}
}

interface ExperimentalPiSessionRuntimeOptions {
	session: Session;
	modelRuntime: ModelRuntime;
	settingsManager: SettingsManager;
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	env: NodeExecutionEnv;
	acquired: AcquiredLock;
	streamOptions: {
		transport: ReturnType<SettingsManager["getTransport"]>;
		timeoutMs: number;
		maxRetries?: number;
		maxRetryDelayMs: number;
	};
}

type PhasedAgentHarness = AgentHarness<ExecutionToolContext> & {
	getPhase(): AgentHarnessPhase;
};

export class ExperimentalPiSessionRuntime implements PiSessionRuntime {
	private readonly session: Session;
	private readonly modelRuntime: ModelRuntime;
	private readonly settingsManager: SettingsManager;
	private readonly env: NodeExecutionEnv;
	private readonly acquired: AcquiredLock;
	private readonly harness: PhasedAgentHarness;
	private readonly unsubscribeLockCompromise: () => void;
	private readonly listeners = new Set<(event: PiSessionRuntimeEvent) => void>();
	private readonly liveItems = new Map<string, TranscriptItem>();
	private readonly liveOrder: string[] = [];
	private readonly toolInputs = new Map<string, { toolName: string; input: JsonValue; timestamp: number }>();
	private unsubscribeHarness: () => void;
	private revision = 0;
	private lockCompromise?: Error;
	private queuedSteerCount = 0;
	private queuedSteer: ReturnType<typeof normalizeUserMessage>[] = [];
	private mutationInFlight = false;
	private disposed = false;
	private disposePromise?: Promise<void>;

	constructor(options: ExperimentalPiSessionRuntimeOptions) {
		this.session = options.session;
		this.modelRuntime = options.modelRuntime;
		this.settingsManager = options.settingsManager;
		this.env = options.env;
		this.acquired = options.acquired;
		const tools: AgentHarnessTool<ExecutionToolContext>[] = [
			createReadTool(),
			createBashTool({
				commandPrefix: this.settingsManager.getShellCommandPrefix(),
				prepare: async (execution) => {
					this.assertUsable();
					const metadata = await this.session.getMetadata();
					execution.env.PI_SESSION_ID = metadata.id;
					if ("path" in metadata && typeof metadata.path === "string")
						execution.env.PI_SESSION_FILE = metadata.path;
					execution.env.PI_PROVIDER = this.harness.getModel().provider;
					execution.env.PI_MODEL = this.harness.getModel().id;
					execution.env.PI_REASONING_LEVEL = this.harness.getThinkingLevel();
				},
			}),
			createEditTool(),
			createWriteTool(),
		];
		this.harness = new AgentHarness<ExecutionToolContext>({
			session: this.session,
			models: this.modelRuntime,
			model: options.model,
			thinkingLevel: options.thinkingLevel,
			tools,
			activeToolNames: [...TOOL_NAMES],
			toolContext: { env: this.env },
			resources: {},
			steeringMode: this.settingsManager.getSteeringMode(),
			followUpMode: this.settingsManager.getFollowUpMode(),
			streamOptions: options.streamOptions,
			systemPrompt: async () => {
				this.assertUsable();
				const metadata = await this.session.getMetadata();
				const cwd = "cwd" in metadata && typeof metadata.cwd === "string" ? metadata.cwd : this.env.cwd;
				return buildSystemPrompt({
					cwd,
					selectedTools: [...TOOL_NAMES],
					toolSnippets: TOOL_SNIPPETS,
					promptGuidelines: TOOL_GUIDELINES,
					contextFiles: [],
					skills: [],
				});
			},
		}) as PhasedAgentHarness;
		this.harness.on("before_provider_request", (event) => {
			const merged = mergeProviderAttributionHeaders(event.model, this.settingsManager, event.sessionId);
			const headers = merged
				? Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== null))
				: undefined;
			return { streamOptions: { headers } };
		});
		this.unsubscribeHarness = this.harness.subscribe((event) => {
			try {
				this.handleHarnessEvent(event);
			} catch {
				// Protocol progress is best-effort and must never fail the harness run.
			}
		});
		this.unsubscribeLockCompromise = this.acquired.onCompromised((error) => this.handleLockCompromise(error));
	}

	getPhase(): SessionPhase {
		return this.harness.getPhase();
	}

	async snapshot(): Promise<SessionSnapshot> {
		this.assertUsable();
		const metadata = await this.session.getMetadata();
		if (!("cwd" in metadata) || typeof metadata.cwd !== "string") {
			throw new PiServerError("invalid_request", "Session metadata is missing cwd");
		}
		const branch = await getFullActiveBranch(this.session);
		const createdAt = parseCreatedAt(metadata.createdAt);
		const stored = readStoredSessionState(branch, createdAt);
		const persisted = normalizeBranchTranscript(branch);
		return {
			id: metadata.id,
			name: stored.name,
			cwd: metadata.cwd,
			createdAt,
			updatedAt: stored.updatedAt,
			phase: this.getPhase(),
			model: { provider: this.harness.getModel().provider, id: this.harness.getModel().id },
			thinkingLevel: this.harness.getThinkingLevel(),
			attached: false,
			locked: true,
			revision: this.revision,
			transcript: mergeLiveTranscript(persisted, this.liveItems, this.liveOrder),
			queuedSteer: structuredClone(this.queuedSteer),
			queuedSteerCount: this.queuedSteerCount,
		};
	}

	async prompt(input: PromptInput): Promise<void> {
		this.assertIdle("prompt");
		try {
			await this.harness.prompt(input.text);
			this.throwIfLockCompromised();
		} catch (error) {
			this.throwIfLockCompromised();
			throw toPiServerError(error);
		}
	}

	async steer(input: SteerInput): Promise<void> {
		this.assertUsable();
		if (this.getPhase() !== "turn") throw new PiServerError("busy", "Session is not accepting steering input");
		try {
			await this.harness.steer(input.text);
			this.throwIfLockCompromised();
		} catch (error) {
			this.throwIfLockCompromised();
			throw toPiServerError(error);
		}
	}

	async abort(): Promise<void> {
		this.assertUsable();
		try {
			await this.harness.abort();
			this.throwIfLockCompromised();
		} catch (error) {
			this.throwIfLockCompromised();
			throw toPiServerError(error);
		}
	}

	async setModel(reference: ModelRef): Promise<void> {
		await this.runExclusiveMutation("set model", async () => {
			const model = this.modelRuntime.getModel(reference.provider, reference.id);
			if (!model) {
				throw new PiServerError("invalid_request", `Unknown model: ${reference.provider}/${reference.id}`);
			}
			if (!this.modelRuntime.hasConfiguredAuth(model.provider)) {
				throw new PiServerError(
					"invalid_request",
					`Model is not authenticated: ${reference.provider}/${reference.id}`,
				);
			}
			await this.harness.setModel(model);
			const currentThinking = this.harness.getThinkingLevel();
			const clamped = clampThinkingLevel(model, currentThinking);
			if (clamped !== currentThinking) await this.harness.setThinkingLevel(clamped);
		});
	}

	async setThinking(thinkingLevel: ThinkingLevel): Promise<void> {
		await this.runExclusiveMutation("set thinking", async () => {
			const model = this.harness.getModel();
			if (clampThinkingLevel(model, thinkingLevel) !== thinkingLevel) {
				throw new PiServerError(
					"invalid_request",
					`Thinking level ${thinkingLevel} is not supported by ${model.provider}/${model.id}`,
				);
			}
			await this.harness.setThinkingLevel(thinkingLevel);
		});
	}

	subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async dispose(): Promise<void> {
		if (this.disposePromise) return this.disposePromise;
		this.disposed = true;
		const current = (async () => {
			try {
				this.unsubscribeHarness();
				this.unsubscribeLockCompromise();
				this.listeners.clear();
				if (this.harness.getPhase() !== "idle") {
					await this.harness.abort().catch(() => {});
				}
				await this.harness.waitForIdle().catch(() => {});
				await this.env.cleanup();
			} finally {
				await this.acquired.release();
			}
		})();
		this.disposePromise = current;
		try {
			await current;
		} catch (error) {
			if (this.disposePromise === current) this.disposePromise = undefined;
			throw error;
		}
	}

	private assertUsable(): void {
		this.throwIfLockCompromised();
		if (this.disposed) throw new PiServerError("invalid_request", "Session runtime is disposed");
	}

	private throwIfLockCompromised(): void {
		const compromised = this.lockCompromise ?? this.acquired.compromisedError();
		if (compromised) {
			throw new PiServerError("session_locked", `Session lock was compromised: ${compromised.message}`);
		}
	}

	private handleLockCompromise(error: Error): void {
		if (this.lockCompromise) return;
		this.lockCompromise = error;
		this.mutationInFlight = true;
		this.harness.terminate(error);
		this.emit({
			type: "error",
			error: new PiServerError("session_locked", `Session lock was compromised: ${error.message}`),
		});
	}

	private assertIdle(operation: string): void {
		this.assertUsable();
		if (this.mutationInFlight || this.getPhase() !== "idle") {
			throw new PiServerError("busy", `Cannot ${operation} while session is busy`);
		}
	}

	private async runExclusiveMutation(operation: string, mutation: () => Promise<void>): Promise<void> {
		this.assertIdle(operation);
		this.mutationInFlight = true;
		try {
			await mutation();
			this.throwIfLockCompromised();
		} catch (error) {
			this.throwIfLockCompromised();
			throw toPiServerError(error);
		} finally {
			this.mutationInFlight = false;
		}
	}

	private rememberLiveItem(item: TranscriptItem): void {
		if (!this.liveItems.has(item.id)) this.liveOrder.push(item.id);
		this.liveItems.set(item.id, item);
	}

	private forgetLiveItem(id: string): void {
		this.liveItems.delete(id);
		const index = this.liveOrder.indexOf(id);
		if (index >= 0) this.liveOrder.splice(index, 1);
	}

	private touch(): void {
		this.revision += 1;
	}

	private emit(event: PiSessionRuntimeEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// A disconnected or broken transport subscriber cannot affect the harness.
			}
		}
	}

	private emitProgress(progress: TranscriptProgress): void {
		this.touch();
		this.emit({ type: "progress", progress });
	}

	private emitChange(progress?: TranscriptProgress): void {
		this.touch();
		if (progress) this.emit({ type: "progress", progress });
		this.emit({ type: "snapshot" });
	}

	private createToolItem(
		toolCallId: string,
		toolName: string,
		input: JsonValue,
		result: ToolProgressResult,
		status: ToolTranscriptItem["status"],
		isError: boolean,
		timestamp: number,
	): ToolTranscriptItem {
		return {
			id: `tool-${toolCallId}`,
			role: "tool",
			toolCallId,
			toolName: toolName || "unknown",
			input,
			content: result.content,
			...(result.details === undefined ? {} : { details: result.details }),
			status,
			isError,
			...(result.usage === undefined ? {} : { usage: result.usage }),
			timestamp,
		};
	}

	private handleHarnessEvent(event: AgentHarnessEvent): void {
		if (event.type === "message_start") {
			const message = event.message;
			if (isAssistantMessage(message)) {
				const item = normalizeAssistantMessage(message, true);
				this.rememberLiveItem(item);
				this.emitChange({ type: "item_started", item });
				return;
			}
			if (isUserMessage(message)) {
				const item = normalizeUserMessage(message);
				this.rememberLiveItem(item);
				this.emitChange({ type: "item_started", item });
				return;
			}
			this.emitChange();
			return;
		}

		if (event.type === "message_update" && isAssistantMessage(event.message)) {
			const item = normalizeAssistantMessage(event.message, true);
			this.rememberLiveItem(item);
			const update = event.assistantMessageEvent;
			if (update.type === "text_delta" || update.type === "thinking_delta" || update.type === "toolcall_delta") {
				this.emitProgress({
					type: "assistant_delta",
					messageId: item.id,
					contentIndex: update.contentIndex,
					kind:
						update.type === "text_delta" ? "text" : update.type === "thinking_delta" ? "thinking" : "tool_call",
					delta: update.delta,
				});
			} else {
				this.emitProgress({ type: "item_updated", item });
			}
			return;
		}

		if (event.type === "message_end") {
			const message = event.message;
			const id = normalizedMessageId(message);
			if (isAssistantMessage(message)) {
				const item = normalizeAssistantMessage(message);
				this.rememberLiveItem(item);
				this.touch();
				this.emit({ type: "progress", progress: { type: "item_finished", item } });
				this.forgetLiveItem(id);
				this.emit({ type: "snapshot" });
				return;
			}
			if (isToolResultMessage(message)) {
				const call = this.toolInputs.get(message.toolCallId);
				const item = normalizeToolMessage(message, call);
				this.rememberLiveItem(item);
				this.forgetLiveItem(item.id);
				this.toolInputs.delete(message.toolCallId);
				this.emitChange();
				return;
			}
			this.forgetLiveItem(id);
			this.emitChange();
			return;
		}

		if (event.type === "tool_execution_start") {
			const input = toJsonValue(event.args) ?? null;
			const startedAt = Date.now();
			this.toolInputs.set(event.toolCallId, { toolName: event.toolName, input, timestamp: startedAt });
			const item = this.createToolItem(
				event.toolCallId,
				event.toolName,
				input,
				{ content: [] },
				"running",
				false,
				startedAt,
			);
			this.rememberLiveItem(item);
			this.emitProgress({ type: "item_started", item });
			return;
		}

		if (event.type === "tool_execution_update") {
			const call = this.toolInputs.get(event.toolCallId) ?? {
				toolName: event.toolName,
				input: toJsonValue(event.args) ?? null,
				timestamp: Date.now(),
			};
			this.toolInputs.set(event.toolCallId, call);
			const item = this.createToolItem(
				event.toolCallId,
				event.toolName,
				call.input,
				normalizeToolProgressResult(event.partialResult as unknown),
				"running",
				false,
				call.timestamp,
			);
			this.rememberLiveItem(item);
			this.emitProgress({ type: "item_updated", item });
			return;
		}

		if (event.type === "tool_execution_end") {
			const call = this.toolInputs.get(event.toolCallId) ?? {
				toolName: event.toolName,
				input: null,
				timestamp: Date.now(),
			};
			const item = this.createToolItem(
				event.toolCallId,
				event.toolName,
				call.input,
				normalizeToolProgressResult(event.result as unknown),
				event.isError ? "error" : "complete",
				event.isError,
				call.timestamp,
			);
			this.rememberLiveItem(item);
			this.emitProgress({ type: "item_finished", item });
			return;
		}

		if (event.type === "queue_update") {
			this.queuedSteer = event.steer
				.filter(isUserMessage)
				.map((message, index) => normalizeUserMessage(message, `queued-steer-${message.timestamp}-${index}`));
			this.queuedSteerCount = this.queuedSteer.length;
			this.emitChange();
			return;
		}

		if (
			event.type === "agent_start" ||
			event.type === "agent_end" ||
			event.type === "model_update" ||
			event.type === "thinking_level_update" ||
			event.type === "abort" ||
			event.type === "settled" ||
			event.type === "save_point"
		) {
			this.emitChange();
		}
	}
}

export { toPiServerError };
