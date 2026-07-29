import type { PiClient, PiSessionClient, Unsubscribe } from "@earendil-works/pi-client";
import type {
	ModelMetadata,
	ModelRef,
	ServerEvent,
	SessionPhase,
	SessionSnapshot,
	SessionSummary,
	ThinkingLevel,
	TranscriptItem,
	TranscriptProgress,
} from "@earendil-works/pi-protocol";

export interface ExperimentalClientView {
	snapshot: SessionSnapshot;
	transcript: readonly TranscriptItem[];
}

export class ExperimentalSessionViewModel {
	private snapshotValue: SessionSnapshot | undefined;
	private readonly progressItems = new Map<string, TranscriptItem>();
	private readonly progressOrder: string[] = [];

	get snapshot(): SessionSnapshot | undefined {
		return this.snapshotValue;
	}

	reset(snapshot: SessionSnapshot): void {
		this.snapshotValue = undefined;
		this.progressItems.clear();
		this.progressOrder.length = 0;
		this.applySnapshot(snapshot);
	}

	applySnapshot(snapshot: SessionSnapshot): void {
		if (this.snapshotValue?.id === snapshot.id && snapshot.revision < this.snapshotValue.revision) {
			return;
		}
		this.snapshotValue = structuredClone(snapshot);
		this.progressItems.clear();
		this.progressOrder.length = 0;
	}

	applyProgress(progress: TranscriptProgress): void {
		if (progress.type === "item_started") {
			this.setProgressItem(progress.item);
			return;
		}
		if (progress.type === "item_updated" || progress.type === "item_finished") {
			this.setProgressItem(progress.item);
			return;
		}
		const item = this.findItem(progress.messageId);
		if (!item || item.role !== "assistant") return;
		const content = item.content.map((part, index) => {
			if (index !== progress.contentIndex) return structuredClone(part);
			if (progress.kind === "text" && part.type === "text") return { ...part, text: part.text + progress.delta };
			if (progress.kind === "thinking" && part.type === "thinking") {
				return { ...part, thinking: part.thinking + progress.delta };
			}
			return structuredClone(part);
		});
		this.setProgressItem({ ...item, content });
	}

	view(): ExperimentalClientView | undefined {
		if (!this.snapshotValue) return undefined;
		const transcript = this.snapshotValue.transcript.map((item) => this.progressItems.get(item.id) ?? item);
		const ids = new Set(transcript.map((item) => item.id));
		for (const id of this.progressOrder) {
			if (ids.has(id)) continue;
			const item = this.progressItems.get(id);
			if (item) {
				transcript.push(item);
				ids.add(id);
			}
		}
		for (const item of this.snapshotValue.queuedSteer) {
			if (ids.has(item.id)) continue;
			transcript.push(item);
			ids.add(item.id);
		}
		return { snapshot: this.snapshotValue, transcript };
	}

	private findItem(id: string): TranscriptItem | undefined {
		return this.progressItems.get(id) ?? this.snapshotValue?.transcript.find((item) => item.id === id);
	}

	private setProgressItem(item: TranscriptItem): void {
		if (!this.progressItems.has(item.id)) this.progressOrder.push(item.id);
		this.progressItems.set(item.id, structuredClone(item));
	}
}

export interface CreateRemoteSessionOptions {
	cwd: string;
	model?: ModelRef;
	thinkingLevel?: ThinkingLevel;
}

export class ExperimentalClientController {
	readonly client: PiClient;
	readonly viewModel = new ExperimentalSessionViewModel();

	private sessionValue: PiSessionClient | undefined;
	private unsubscribeSnapshot?: Unsubscribe;
	private unsubscribeEvents?: Unsubscribe;
	private readonly listeners = new Set<(view: ExperimentalClientView) => void>();
	private disposed = false;

	constructor(client: PiClient) {
		this.client = client;
	}

	get session(): PiSessionClient | undefined {
		return this.sessionValue;
	}

	get snapshot(): SessionSnapshot | undefined {
		return this.viewModel.snapshot;
	}

	get phase(): SessionPhase | undefined {
		return this.snapshot?.phase;
	}

	get models(): readonly ModelMetadata[] {
		return this.client.snapshot?.models ?? [];
	}

	get sessions(): readonly SessionSummary[] {
		return this.client.sessions;
	}

	subscribe(listener: (view: ExperimentalClientView) => void): Unsubscribe {
		this.listeners.add(listener);
		const view = this.viewModel.view();
		if (view) this.callListener(listener, view);
		return () => this.listeners.delete(listener);
	}

	async attachInitial(session: PiSessionClient): Promise<void> {
		this.assertActive();
		if (!session.attached) throw new Error(`Session ${session.id} must be attached before use`);
		this.bindSession(session);
	}

	async switchToSession(sessionId: string): Promise<void> {
		this.assertIdle("resume a session");
		if (this.sessionValue?.id === sessionId) return;
		const next = await this.client.attachSession(sessionId);
		await this.switchPreparedSession(next);
	}

	async createAndSwitch(options: CreateRemoteSessionOptions): Promise<void> {
		this.assertIdle("create a session");
		const next = await this.client.createSession(options);
		await this.switchPreparedSession(next);
	}

	async submit(text: string): Promise<void> {
		this.assertActive();
		const session = this.requireSession();
		const normalized = text.trim();
		if (!normalized) return;
		if (this.phase === "idle") {
			await session.prompt(normalized);
			return;
		}
		if (this.phase === "turn") {
			await session.steer(normalized);
			return;
		}
		throw new Error(`Session cannot accept input during ${this.phase ?? "unknown"} phase`);
	}

	async abort(): Promise<void> {
		this.assertActive();
		if (this.phase === "idle") return;
		await this.requireSession().abort();
	}

	async setModel(model: ModelRef): Promise<void> {
		this.assertIdle("change model");
		await this.requireSession().setModel(model);
	}

	async setThinking(thinkingLevel: ThinkingLevel): Promise<void> {
		this.assertIdle("change thinking level");
		await this.requireSession().setThinking(thinkingLevel);
	}

	async reconnect(): Promise<void> {
		this.assertActive();
		const sessionId = this.requireSession().id;
		await this.client.reconnect();
		const session = await this.client.attachSession(sessionId);
		this.bindSession(session);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.clearSessionSubscriptions();
		const session = this.sessionValue;
		this.sessionValue = undefined;
		if (session?.attached) await session.detach().catch(() => {});
		this.client.disconnect();
		this.listeners.clear();
	}

	private async switchPreparedSession(next: PiSessionClient): Promise<void> {
		const previous = this.sessionValue;
		if (previous && previous.id !== next.id && previous.attached) {
			try {
				await previous.detach();
			} catch (error) {
				if (next.attached) await next.detach().catch(() => {});
				throw error;
			}
		}
		this.bindSession(next);
	}

	private bindSession(session: PiSessionClient): void {
		this.clearSessionSubscriptions();
		this.sessionValue = session;
		const snapshot = session.snapshot;
		if (!snapshot) throw new Error(`Session ${session.id} did not provide a snapshot`);
		this.viewModel.reset(snapshot);
		this.unsubscribeSnapshot = session.subscribe((next) => {
			try {
				this.viewModel.applySnapshot(next);
				this.notify();
			} catch {
				// UI listeners and view projection are isolated from the transport.
			}
		});
		this.unsubscribeEvents = session.onEvent((event) => this.handleSessionEvent(event));
		this.notify();
	}

	private handleSessionEvent(event: ServerEvent): void {
		try {
			if (event.type === "session_progress") this.viewModel.applyProgress(event.progress);
			if (event.type === "session_snapshot") this.viewModel.applySnapshot(event.snapshot);
			this.notify();
		} catch {
			// A malformed UI projection cannot break PiClient's message handler.
		}
	}

	private notify(): void {
		const view = this.viewModel.view();
		if (!view) return;
		for (const listener of this.listeners) this.callListener(listener, view);
	}

	private callListener(listener: (view: ExperimentalClientView) => void, view: ExperimentalClientView): void {
		try {
			listener(view);
		} catch {
			// Consumer callbacks are never allowed to throw into PiClient.
		}
	}

	private clearSessionSubscriptions(): void {
		this.unsubscribeSnapshot?.();
		this.unsubscribeEvents?.();
		this.unsubscribeSnapshot = undefined;
		this.unsubscribeEvents = undefined;
	}

	private requireSession(): PiSessionClient {
		if (!this.sessionValue) throw new Error("No remote session is attached");
		return this.sessionValue;
	}

	private assertActive(): void {
		if (this.disposed) throw new Error("Experimental client controller is disposed");
	}

	private assertIdle(operation: string): void {
		this.assertActive();
		if (this.phase !== "idle") throw new Error(`Cannot ${operation} while session is ${this.phase ?? "unavailable"}`);
	}
}
