import type { AssistantMessage, ToolCall, Usage } from "@earendil-works/pi-ai";
import type {
	AssistantTranscriptItem,
	JsonValue,
	ModelMetadata,
	SessionSummary,
	ThinkingLevel,
	ToolTranscriptItem,
	TranscriptItem,
} from "@earendil-works/pi-protocol";
import { Container, ProcessTerminal, setKeybindings, Text, TUI } from "@earendil-works/pi-tui";
import { getAgentDir } from "../../config.ts";
import { KeybindingsManager } from "../../core/keybindings.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { AssistantMessageComponent } from "../../modes/interactive/components/assistant-message.ts";
import { CustomEditor } from "../../modes/interactive/components/custom-editor.ts";
import { ExtensionSelectorComponent } from "../../modes/interactive/components/extension-selector.ts";
import { ToolExecutionComponent } from "../../modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../../modes/interactive/components/user-message.ts";
import { getEditorTheme, initTheme, stopThemeWatcher, theme } from "../../modes/interactive/theme/theme.ts";
import type { ExperimentalClientController, ExperimentalClientView } from "./client-controller.ts";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toAiUsage(item: AssistantTranscriptItem): Usage {
	return item.usage ? structuredClone(item.usage) : structuredClone(ZERO_USAGE);
}

function toolArguments(input: JsonValue): ToolCall["arguments"] {
	if (typeof input === "object" && input !== null && !Array.isArray(input)) return input;
	return { value: input };
}

function toAssistantMessage(item: AssistantTranscriptItem, models: readonly ModelMetadata[]): AssistantMessage {
	const metadata = models.find((model) => model.provider === item.model.provider && model.id === item.model.id);
	const content: AssistantMessage["content"] = item.content.map((part) => {
		if (part.type === "text") return { type: "text", text: part.text };
		if (part.type === "thinking") {
			return {
				type: "thinking",
				thinking: part.thinking,
				...(part.redacted === undefined ? {} : { redacted: part.redacted }),
			};
		}
		return {
			type: "toolCall",
			id: part.toolCallId,
			name: part.toolName,
			arguments: toolArguments(part.input),
		};
	});
	const stopReason: AssistantMessage["stopReason"] =
		item.stopReason === "tool_use"
			? "toolUse"
			: (item.stopReason ?? (item.status === "error" ? "error" : item.status === "aborted" ? "aborted" : "stop"));
	return {
		role: "assistant",
		content,
		api: metadata?.api ?? "unknown",
		provider: item.model.provider,
		model: item.model.id,
		...(item.responseModel ? { responseModel: item.responseModel } : {}),
		usage: toAiUsage(item),
		stopReason,
		...(item.errorMessage === undefined ? {} : { errorMessage: item.errorMessage }),
		timestamp: item.timestamp,
	};
}

function userText(item: Extract<TranscriptItem, { role: "user" }>): string {
	return item.content
		.map((part) => (part.type === "text" ? part.text : `[${part.mimeType} image omitted]`))
		.join("\n");
}

function sessionLabel(session: SessionSummary): string {
	const name = session.name?.trim() || session.id.slice(0, 8);
	const lock = session.locked && !session.attached ? " [locked]" : "";
	return `${name} · ${session.cwd} · ${session.id}${lock}`;
}

export class ExperimentalClientTui {
	private readonly controller: ExperimentalClientController;
	private readonly settingsManager: SettingsManager;
	private readonly ui: TUI;
	private readonly transcript = new Container();
	private readonly editor: CustomEditor;
	private readonly footer = new Text("", 1, 0);
	private readonly status = new Text("", 1, 0);
	private unsubscribeController?: () => void;
	private unsubscribeConnection?: () => void;
	private latestView?: ExperimentalClientView;
	private toolsExpanded = false;
	private hideThinking: boolean;
	private shuttingDown = false;
	private finishRun?: () => void;

	constructor(controller: ExperimentalClientController, settingsManager: SettingsManager) {
		this.controller = controller;
		this.settingsManager = settingsManager;
		this.hideThinking = settingsManager.getHideThinkingBlock();
		initTheme(settingsManager.getTheme(), true);
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		this.ui = new TUI(new ProcessTerminal(), settingsManager.getShowHardwareCursor(), getAgentDir());
		this.ui.setClearOnShrink(settingsManager.getClearOnShrink());
		this.editor = new CustomEditor(this.ui, getEditorTheme(), keybindings, {
			paddingX: settingsManager.getEditorPaddingX(),
			autocompleteMaxVisible: settingsManager.getAutocompleteMaxVisible(),
		});
		this.editor.onSubmit = (text) => void this.handleSubmit(text);
		this.editor.onAction("app.interrupt", () => void this.handleInterrupt());
		this.editor.onAction("app.clear", () => this.editor.setText(""));
		this.editor.onAction("app.exit", () => void this.shutdown());
		this.editor.onAction("app.model.select", () => this.showModelSelector());
		this.editor.onAction("app.thinking.cycle", () => void this.cycleThinking());
		this.editor.onAction("app.thinking.toggle", () => {
			this.hideThinking = !this.hideThinking;
			this.rebuildTranscript();
		});
		this.editor.onAction("app.tools.expand", () => {
			this.toolsExpanded = !this.toolsExpanded;
			this.rebuildTranscript();
		});
		this.editor.onAction("app.session.new", () => void this.newSession());
		this.editor.onAction("app.session.resume", () => void this.showResumeSelector());
		this.ui.addChild(this.transcript);
		this.ui.addChild(this.status);
		this.ui.addChild(this.editor);
		this.ui.addChild(this.footer);
		this.ui.setFocus(this.editor);
	}

	async run(initialPrompt?: string): Promise<void> {
		this.unsubscribeController = this.controller.subscribe((view) => this.applyView(view));
		this.unsubscribeConnection = this.controller.client.onConnectionStateChange(({ state, error }) => {
			if (this.shuttingDown) return;
			if (state === "disconnected") {
				this.setStatus(`Disconnected${error ? `: ${error.message}` : ""}. Use /reconnect or /exit.`, true);
			} else if (state === "connecting") {
				this.setStatus("Reconnecting...");
			}
		});
		this.ui.start();
		this.ui.terminal.setTitle("pi experimental client");
		if (initialPrompt?.trim()) queueMicrotask(() => void this.submitPrompt(initialPrompt));
		await new Promise<void>((resolve) => {
			this.finishRun = resolve;
		});
	}

	async shutdown(): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		this.unsubscribeController?.();
		this.unsubscribeController = undefined;
		this.unsubscribeConnection?.();
		this.unsubscribeConnection = undefined;
		await this.ui.terminal.drainInput(1000).catch(() => {});
		this.ui.stop();
		stopThemeWatcher();
		await this.controller.dispose();
		this.finishRun?.();
		this.finishRun = undefined;
	}

	private applyView(view: ExperimentalClientView): void {
		this.latestView = view;
		this.rebuildTranscript();
		const snapshot = view.snapshot;
		this.footer.setText(
			theme.fg(
				"dim",
				`${snapshot.phase} · ${snapshot.model.provider}/${snapshot.model.id} · thinking:${snapshot.thinkingLevel} · ${snapshot.id.slice(0, 8)} · ${snapshot.cwd}`,
			),
		);
		this.ui.requestRender();
	}

	private rebuildTranscript(): void {
		const view = this.latestView;
		if (!view) return;
		this.transcript.clear();
		const toolItems = new Map(
			view.transcript
				.filter((item): item is ToolTranscriptItem => item.role === "tool")
				.map((item) => [item.toolCallId, item]),
		);
		const renderedToolIds = new Set<string>();
		for (const item of view.transcript) {
			if (item.role === "user") {
				this.transcript.addChild(
					new UserMessageComponent(userText(item), undefined, this.settingsManager.getOutputPad()),
				);
				continue;
			}
			if (item.role === "assistant") {
				this.transcript.addChild(
					new AssistantMessageComponent(
						toAssistantMessage(item, this.controller.models),
						this.hideThinking,
						undefined,
						item.status === "streaming" ? "Thinking..." : "Thought",
						this.settingsManager.getOutputPad(),
					),
				);
				for (const part of item.content) {
					if (part.type !== "tool_call") continue;
					const result = toolItems.get(part.toolCallId);
					this.transcript.addChild(this.createToolComponent(part.toolName, part.toolCallId, part.input, result));
					renderedToolIds.add(part.toolCallId);
				}
			}
		}
		for (const item of toolItems.values()) {
			if (renderedToolIds.has(item.toolCallId)) continue;
			this.transcript.addChild(this.createToolComponent(item.toolName, item.toolCallId, item.input, item));
		}
	}

	private createToolComponent(
		toolName: string,
		toolCallId: string,
		input: JsonValue,
		result?: ToolTranscriptItem,
	): ToolExecutionComponent {
		const component = new ToolExecutionComponent(
			toolName,
			toolCallId,
			input,
			{ showImages: false },
			undefined,
			this.ui,
			this.latestView?.snapshot.cwd ?? process.cwd(),
		);
		component.markExecutionStarted();
		component.setArgsComplete();
		component.setExpanded(this.toolsExpanded);
		if (result) {
			component.updateResult(
				{ content: result.content, details: result.details, isError: result.isError },
				result.status === "running",
			);
		}
		return component;
	}

	private async handleSubmit(text: string): Promise<void> {
		const normalized = text.trim();
		if (!normalized) return;
		this.editor.addToHistory(normalized);
		this.editor.setText("");
		if (normalized.startsWith("/")) {
			await this.handleCommand(normalized);
			return;
		}
		await this.submitPrompt(normalized);
	}

	private async submitPrompt(text: string): Promise<void> {
		try {
			this.setStatus("");
			await this.controller.submit(text);
		} catch (error) {
			this.showError(error);
		}
	}

	private async handleCommand(input: string): Promise<void> {
		const space = input.indexOf(" ");
		const command = space === -1 ? input : input.slice(0, space);
		const argument = space === -1 ? "" : input.slice(space + 1).trim();
		if (command === "/new") {
			await this.newSession();
			return;
		}
		if (command === "/resume") {
			await this.showResumeSelector();
			return;
		}
		if (command === "/model") {
			if (argument) await this.selectModelByName(argument);
			else this.showModelSelector();
			return;
		}
		if (command === "/thinking") {
			if (argument) await this.selectThinkingByName(argument);
			else this.showThinkingSelector();
			return;
		}
		if (command === "/reconnect") {
			await this.reconnect();
			return;
		}

		if (command === "/quit" || command === "/exit") {
			await this.shutdown();
			return;
		}
		this.setStatus(`Unknown command: ${command}`, true);
	}

	private async reconnect(): Promise<void> {
		if (this.controller.client.connectionState !== "disconnected") {
			this.setStatus(`Client is ${this.controller.client.connectionState}`);
			return;
		}
		try {
			await this.controller.reconnect();
			this.setStatus("Reconnected");
		} catch (error) {
			this.showError(error);
		}
	}

	private async handleInterrupt(): Promise<void> {
		try {
			if (this.controller.phase === "idle") {
				this.editor.setText("");
				return;
			}
			await this.controller.abort();
		} catch (error) {
			this.showError(error);
		}
	}

	private async newSession(): Promise<void> {
		if (!this.requireIdle("create a new session")) return;
		const cwd = this.latestView?.snapshot.cwd;
		if (!cwd) return;
		try {
			await this.controller.createAndSwitch({ cwd });
			this.setStatus("Created a new session");
		} catch (error) {
			this.showError(error);
		}
	}

	private async showResumeSelector(): Promise<void> {
		if (!this.requireIdle("resume a session")) return;
		try {
			const sessions = await this.controller.client.listSessions();
			const currentId = this.controller.session?.id;
			const candidates = sessions.filter((session) => session.id !== currentId);
			if (candidates.length === 0) {
				this.setStatus("No other sessions are available");
				return;
			}
			const labels = candidates.map(sessionLabel);
			this.showSelector("Resume session", labels, async (label) => {
				const selected = candidates[labels.indexOf(label)];
				if (!selected) return;
				await this.controller.switchToSession(selected.id);
				this.setStatus(`Attached to ${selected.id}`);
			});
		} catch (error) {
			this.showError(error);
		}
	}

	private showModelSelector(): void {
		if (!this.requireIdle("change model")) return;
		const models = this.controller.models.filter((model) => model.authenticated);
		if (models.length === 0) {
			this.setStatus("No authenticated models are available", true);
			return;
		}
		const labels = models.map((model) => `${model.provider}/${model.id} · ${model.name}`);
		this.showSelector("Select model", labels, async (label) => {
			const selected = models[labels.indexOf(label)];
			if (!selected) return;
			await this.controller.setModel({ provider: selected.provider, id: selected.id });
			this.setStatus(`Model: ${selected.provider}/${selected.id}`);
		});
	}

	private async selectModelByName(name: string): Promise<void> {
		if (!this.requireIdle("change model")) return;
		const matches = this.controller.models.filter(
			(model) => model.authenticated && (`${model.provider}/${model.id}` === name || model.id === name),
		);
		if (matches.length !== 1) {
			this.setStatus(matches.length === 0 ? `Unknown model: ${name}` : `Ambiguous model: ${name}`, true);
			return;
		}
		try {
			await this.controller.setModel({ provider: matches[0].provider, id: matches[0].id });
		} catch (error) {
			this.showError(error);
		}
	}

	private showThinkingSelector(): void {
		if (!this.requireIdle("change thinking level")) return;
		const model = this.currentModel();
		if (!model) return;
		this.showSelector("Select thinking level", [...model.supportedThinkingLevels], async (label) => {
			await this.controller.setThinking(label as ThinkingLevel);
			this.setStatus(`Thinking: ${label}`);
		});
	}

	private async selectThinkingByName(name: string): Promise<void> {
		if (!this.requireIdle("change thinking level")) return;
		const model = this.currentModel();
		if (!model?.supportedThinkingLevels.includes(name as ThinkingLevel)) {
			this.setStatus(`Unsupported thinking level: ${name}`, true);
			return;
		}
		try {
			await this.controller.setThinking(name as ThinkingLevel);
		} catch (error) {
			this.showError(error);
		}
	}

	private async cycleThinking(): Promise<void> {
		if (!this.requireIdle("change thinking level")) return;
		const model = this.currentModel();
		const current = this.latestView?.snapshot.thinkingLevel;
		if (!model || !current) return;
		const index = model.supportedThinkingLevels.indexOf(current);
		const next = model.supportedThinkingLevels[(index + 1) % model.supportedThinkingLevels.length];
		if (!next) return;
		try {
			await this.controller.setThinking(next);
		} catch (error) {
			this.showError(error);
		}
	}

	private currentModel(): ModelMetadata | undefined {
		const reference = this.latestView?.snapshot.model;
		return reference
			? this.controller.models.find((model) => model.provider === reference.provider && model.id === reference.id)
			: undefined;
	}

	private showSelector(title: string, options: string[], onSelect: (option: string) => Promise<void>): void {
		let close = () => {};
		const selector = new ExtensionSelectorComponent(
			title,
			options,
			(option) => {
				close();
				void onSelect(option).catch((error) => this.showError(error));
			},
			() => close(),
			{ tui: this.ui },
		);
		const handle = this.ui.showOverlay(selector, { width: "80%", maxHeight: "80%", margin: 1 });
		close = () => {
			selector.dispose();
			handle.hide();
		};
	}

	private requireIdle(operation: string): boolean {
		if (this.controller.phase === "idle") return true;
		this.setStatus(`Cannot ${operation} while session is ${this.controller.phase ?? "unavailable"}`, true);
		return false;
	}

	private setStatus(message: string, error = false): void {
		this.status.setText(message ? theme.fg(error ? "error" : "muted", message) : "");
		this.ui.requestRender();
	}

	private showError(error: unknown): void {
		this.setStatus(error instanceof Error ? error.message : String(error), true);
	}
}

export { sessionLabel, toAssistantMessage };
