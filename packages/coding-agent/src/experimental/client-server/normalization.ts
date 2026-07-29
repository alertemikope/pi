import type { AgentMessage, Session, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type {
	ImageContent as AiImageContent,
	TextContent as AiTextContent,
	Usage as AiUsage,
	Api,
	AssistantMessage,
	Model,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type {
	AssistantTranscriptItem,
	JsonValue,
	ModelMetadata,
	ThinkingLevel,
	ToolTranscriptItem,
	TranscriptItem,
	Usage,
	UserTranscriptItem,
} from "@earendil-works/pi-protocol";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function isThinkingLevel(value: string): value is ThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

export function toJsonValue(value: unknown, seen = new Set<object>()): JsonValue | undefined {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value === "bigint") return value.toString();
	if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
	if (value instanceof Date) return value.toISOString();
	if (typeof value !== "object") return String(value);
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	try {
		if (Array.isArray(value)) return value.map((entry) => toJsonValue(entry, seen) ?? null);
		const result: Record<string, JsonValue> = {};
		for (const [key, entry] of Object.entries(value)) {
			const normalized = toJsonValue(entry, seen);
			if (normalized !== undefined) result[key] = normalized;
		}
		return result;
	} finally {
		seen.delete(value);
	}
}

function timestamp(value: number): number {
	return Number.isFinite(value) && value >= 0 ? Math.floor(value) : Date.now();
}

function nonNegativeInteger(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.floor(value));
}

function nonNegativeNumber(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function normalizeUsage(usage: AiUsage | undefined): Usage | undefined {
	if (!usage) return undefined;
	const reasoning = nonNegativeInteger(usage.reasoning);
	return {
		input: nonNegativeInteger(usage.input) ?? 0,
		output: nonNegativeInteger(usage.output) ?? 0,
		cacheRead: nonNegativeInteger(usage.cacheRead) ?? 0,
		cacheWrite: nonNegativeInteger(usage.cacheWrite) ?? 0,
		...(reasoning === undefined ? {} : { reasoning }),
		totalTokens: nonNegativeInteger(usage.totalTokens) ?? 0,
		cost: {
			input: nonNegativeNumber(usage.cost.input),
			output: nonNegativeNumber(usage.cost.output),
			cacheRead: nonNegativeNumber(usage.cost.cacheRead),
			cacheWrite: nonNegativeNumber(usage.cost.cacheWrite),
			total: nonNegativeNumber(usage.cost.total),
		},
	};
}

export function normalizeModelMetadata(model: Model<Api>, authenticated: boolean): ModelMetadata {
	return {
		provider: model.provider,
		id: model.id,
		name: model.name || model.id,
		api: model.api,
		reasoning: model.reasoning,
		input: [...model.input],
		contextWindow: Math.max(1, Math.floor(model.contextWindow)),
		maxTokens: Math.max(1, Math.floor(model.maxTokens)),
		cost: {
			input: nonNegativeNumber(model.cost.input),
			output: nonNegativeNumber(model.cost.output),
			cacheRead: nonNegativeNumber(model.cost.cacheRead),
			cacheWrite: nonNegativeNumber(model.cost.cacheWrite),
		},
		supportedThinkingLevels: getSupportedThinkingLevels(model),
		authenticated,
	};
}

function normalizeUserContent(content: UserMessage["content"]): UserTranscriptItem["content"] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return content.map((part) =>
		part.type === "image"
			? { type: "image", data: part.data, mimeType: part.mimeType }
			: { type: "text", text: part.text },
	);
}

function normalizeAssistantContent(message: AssistantMessage): AssistantTranscriptItem["content"] {
	return message.content.map((part) => {
		if (part.type === "text") return { type: "text" as const, text: part.text };
		if (part.type === "thinking") {
			return {
				type: "thinking" as const,
				thinking: part.thinking,
				...(part.redacted === undefined ? {} : { redacted: part.redacted }),
			};
		}
		return {
			type: "tool_call" as const,
			toolCallId: part.id || `tool-${message.timestamp}`,
			toolName: part.name || "unknown",
			input: toJsonValue(part.arguments) ?? null,
		};
	});
}

function assistantStopReason(
	stopReason: AssistantMessage["stopReason"],
): AssistantTranscriptItem["stopReason"] | undefined {
	if (stopReason === "toolUse") return "tool_use";
	if (stopReason === "pending") return undefined;
	return stopReason;
}

function assistantStatus(message: AssistantMessage, streaming: boolean): AssistantTranscriptItem["status"] {
	if (streaming) return "streaming";
	if (message.stopReason === "error") return "error";
	if (message.stopReason === "aborted") return "aborted";
	return "complete";
}

export function normalizedMessageId(message: AgentMessage): string {
	if (message.role === "toolResult") return `tool-${message.toolCallId || message.timestamp}`;
	return `${message.role}-${timestamp(message.timestamp)}`;
}

export function normalizeAssistantMessage(
	message: AssistantMessage,
	streaming = false,
	id = normalizedMessageId(message),
): AssistantTranscriptItem {
	const stopReason = streaming ? undefined : assistantStopReason(message.stopReason);
	const usage = normalizeUsage(message.usage);
	return {
		id,
		role: "assistant",
		content: normalizeAssistantContent(message),
		status: assistantStatus(message, streaming),
		model: { provider: message.provider, id: message.model },
		...(message.responseModel ? { responseModel: message.responseModel } : {}),
		...(usage ? { usage } : {}),
		...(stopReason ? { stopReason } : {}),
		...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
		timestamp: timestamp(message.timestamp),
	};
}

export function normalizeUserMessage(message: UserMessage, id = normalizedMessageId(message)): UserTranscriptItem {
	return {
		id,
		role: "user",
		content: normalizeUserContent(message.content),
		timestamp: timestamp(message.timestamp),
	};
}

interface ToolCallInfo {
	toolName: string;
	input: JsonValue;
}

function normalizeToolContent(content: Array<AiTextContent | AiImageContent>): ToolTranscriptItem["content"] {
	return content.map((part) =>
		part.type === "image"
			? { type: "image", data: part.data, mimeType: part.mimeType }
			: { type: "text", text: part.text },
	);
}

export function normalizeToolMessage(
	message: ToolResultMessage,
	call?: ToolCallInfo,
	id = normalizedMessageId(message),
): ToolTranscriptItem {
	const details = toJsonValue(message.details);
	const usage = normalizeUsage(message.usage);
	return {
		id,
		role: "tool",
		toolCallId: message.toolCallId || `tool-${message.timestamp}`,
		toolName: message.toolName || call?.toolName || "unknown",
		input: call?.input ?? null,
		content: normalizeToolContent(message.content),
		...(details === undefined ? {} : { details }),
		status: message.isError ? "error" : "complete",
		isError: message.isError,
		...(usage ? { usage } : {}),
		timestamp: timestamp(message.timestamp),
	};
}

export function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant";
}

export function isUserMessage(message: AgentMessage): message is UserMessage {
	return message.role === "user";
}

export function isToolResultMessage(message: AgentMessage): message is ToolResultMessage {
	return message.role === "toolResult";
}

export async function getFullActiveBranch(session: Session): Promise<SessionTreeEntry[]> {
	const branch: SessionTreeEntry[] = [];
	const visited = new Set<string>();
	let id = await session.getLeafId();
	while (id !== null) {
		if (visited.has(id)) throw new Error(`Session branch contains a cycle at ${id}`);
		visited.add(id);
		const entry = await session.getEntry(id);
		if (!entry) throw new Error(`Session branch entry ${id} was not found`);
		branch.unshift(entry);
		id = entry.parentId;
	}
	return branch;
}

export function normalizeBranchTranscript(entries: readonly SessionTreeEntry[]): TranscriptItem[] {
	const calls = new Map<string, ToolCallInfo>();
	const transcript: TranscriptItem[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (isUserMessage(message)) {
			transcript.push(normalizeUserMessage(message, entry.id));
			continue;
		}
		if (isAssistantMessage(message)) {
			for (const part of message.content) {
				if (part.type === "toolCall") {
					calls.set(part.id, {
						toolName: part.name,
						input: toJsonValue(part.arguments) ?? null,
					});
				}
			}
			transcript.push(normalizeAssistantMessage(message, false, entry.id));
			continue;
		}
		if (isToolResultMessage(message)) {
			transcript.push(normalizeToolMessage(message, calls.get(message.toolCallId), entry.id));
		}
	}
	return transcript;
}

export function mergeLiveTranscript(
	persisted: readonly TranscriptItem[],
	liveItems: ReadonlyMap<string, TranscriptItem>,
	liveOrder: readonly string[],
): TranscriptItem[] {
	const result = persisted.map((item) => liveItems.get(item.id) ?? item);
	const persistedIds = new Set(persisted.map((item) => item.id));
	for (const id of liveOrder) {
		if (persistedIds.has(id)) continue;
		const item = liveItems.get(id);
		if (item) result.push(item);
	}
	return result;
}

export interface StoredSessionState {
	model: { provider: string; id: string } | undefined;
	thinkingLevel: ThinkingLevel | undefined;
	invalidThinkingLevel: string | undefined;
	name: string | undefined;
	updatedAt: number;
}

export function readStoredSessionState(entries: readonly SessionTreeEntry[], createdAt: number): StoredSessionState {
	let model: StoredSessionState["model"];
	let thinkingLevel: ThinkingLevel | undefined;
	let invalidThinkingLevel: string | undefined;
	let name: string | undefined;
	let updatedAt = createdAt;
	for (const entry of entries) {
		const entryTime = Date.parse(entry.timestamp);
		if (Number.isFinite(entryTime)) updatedAt = Math.max(updatedAt, entryTime);
		if (entry.type === "model_change") model = { provider: entry.provider, id: entry.modelId };
		if (entry.type === "thinking_level_change") {
			if (isThinkingLevel(entry.thinkingLevel)) {
				thinkingLevel = entry.thinkingLevel;
				invalidThinkingLevel = undefined;
			} else {
				thinkingLevel = undefined;
				invalidThinkingLevel = entry.thinkingLevel;
			}
		}
		if (entry.type === "message" && isAssistantMessage(entry.message)) {
			model = { provider: entry.message.provider, id: entry.message.model };
		}
		if (entry.type === "session_info") name = entry.name?.trim() || undefined;
	}
	return { model, thinkingLevel, invalidThinkingLevel, name, updatedAt };
}
