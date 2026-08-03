import type { AgentOperationOutcome, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { captureGitOperationSnapshot, type GitOperationSnapshot, inspectGitWorkspace } from "./git.ts";

const ENTRY_TYPE = "pi.git-operation-snapshot";
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

interface OpenedTransaction {
	schema: 1;
	event: "opened";
	transactionId: string;
	operationId: string;
	sessionId: string;
	cwd: string;
	openedAt: number;
	snapshot?: GitOperationSnapshot;
	error?: string;
}

interface ClosedTransaction {
	schema: 1;
	event: "closed";
	transactionId: string;
	operationId: string;
	outcome: AgentOperationOutcome;
	closedAt: number;
	finalHeadOid?: string;
	finalStatusHash?: string;
	error?: string;
}

function isOpenedTransaction(value: unknown): value is OpenedTransaction {
	return (
		!!value &&
		typeof value === "object" &&
		"schema" in value &&
		value.schema === 1 &&
		"event" in value &&
		value.event === "opened" &&
		"transactionId" in value &&
		typeof value.transactionId === "string" &&
		"operationId" in value &&
		typeof value.operationId === "string"
	);
}

function findOpenTransaction(ctx: ExtensionContext, operationId: string): OpenedTransaction | undefined {
	const open = new Map<string, OpenedTransaction>();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE || !entry.data || typeof entry.data !== "object") {
			continue;
		}
		if (isOpenedTransaction(entry.data)) {
			open.set(entry.data.transactionId, entry.data);
		} else if (
			"event" in entry.data &&
			entry.data.event === "closed" &&
			"transactionId" in entry.data &&
			typeof entry.data.transactionId === "string"
		) {
			open.delete(entry.data.transactionId);
		}
	}
	return [...open.values()].find((transaction) => transaction.operationId === operationId);
}

export default function gitOperationSnapshots(pi: ExtensionAPI): void {
	let active: OpenedTransaction | undefined;

	pi.on("agent_start", async (event, ctx) => {
		if (!event.operation || !ctx.isProjectTrusted() || active?.operationId === event.operation.id) return;
		const existing = findOpenTransaction(ctx, event.operation.id);
		if (existing) {
			active = existing;
			return;
		}
		const repositoryCheck = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ctx.cwd });
		if (
			repositoryCheck.termination.kind !== "exited" ||
			repositoryCheck.termination.code !== 0 ||
			repositoryCheck.stdout.trim() !== "true"
		) {
			return;
		}

		const transactionId = event.operation.id;
		const opened: OpenedTransaction = {
			schema: 1,
			event: "opened",
			transactionId,
			operationId: event.operation.id,
			sessionId: ctx.sessionManager.getSessionId(),
			cwd: ctx.cwd,
			openedAt: Date.now(),
		};
		try {
			opened.snapshot = await captureGitOperationSnapshot(
				{ run: (args) => pi.exec("git", args, { cwd: ctx.cwd }) },
				{ sessionId: opened.sessionId, operationId: opened.operationId },
			);
		} catch (error) {
			opened.error = error instanceof Error ? error.message : String(error);
		}
		pi.appendEntry(ENTRY_TYPE, opened);
		active = opened;
	});

	pi.on("tool_call", (event) => {
		if (!active?.error || READ_ONLY_TOOLS.has(event.toolName)) return undefined;
		return {
			block: true,
			reason: `Workspace mutation blocked because the Git operation snapshot failed: ${active.error}`,
		};
	});

	pi.on("agent_settled", async (event, ctx) => {
		if (!event.operation || active?.operationId !== event.operation.id) return;
		const closed: ClosedTransaction = {
			schema: 1,
			event: "closed",
			transactionId: active.transactionId,
			operationId: active.operationId,
			outcome: event.outcome,
			closedAt: Date.now(),
		};
		try {
			const finalState = await inspectGitWorkspace({ run: (args) => pi.exec("git", args, { cwd: ctx.cwd }) });
			closed.finalHeadOid = finalState.headOid;
			closed.finalStatusHash = finalState.statusHash;
		} catch (error) {
			closed.error = error instanceof Error ? error.message : String(error);
		}
		pi.appendEntry(ENTRY_TYPE, closed);
		active = undefined;
	});
}
