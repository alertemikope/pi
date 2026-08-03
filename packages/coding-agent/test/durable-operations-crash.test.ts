import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DurableOperationJournal } from "../src/core/durable-operations.ts";

const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("DurableOperationJournal process crash matrix", () => {
	let tempDir: string | undefined;
	const children = new Set<ChildProcess>();

	afterEach(() => {
		for (const child of children) child.kill("SIGKILL");
		children.clear();
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	it.each([
		{ mode: "running", expectedEffects: [] },
		{ mode: "reserved", expectedEffects: ["reserved"] },
		{ mode: "dispatched", expectedEffects: ["unresolved"] },
	])(
		"recovers $mode state after a real SIGKILL",
		async ({ mode, expectedEffects }) => {
			tempDir = mkdtempSync(join(tmpdir(), "pi-durable-crash-"));
			const journalPath = join(tempDir, "operations.jsonl");
			const scriptPath = join(tempDir, "crash-child.mjs");
			const moduleUrl = pathToFileURL(resolve(import.meta.dirname, "../src/core/durable-operations.ts")).href;
			writeFileSync(
				scriptPath,
				`import { DurableOperationJournal } from ${JSON.stringify(moduleUrl)};
const [journalPath, sessionId, mode] = process.argv.slice(2);
const journal = new DurableOperationJournal(journalPath, sessionId, { exclusive: true });
const operation = journal.begin("crash matrix");
if (mode === "reserved") {
  journal.reserveEffect(operation, { assistantEntryId: "assistant", toolIndex: 0, toolCallId: "call", toolName: "child" });
} else if (mode === "dispatched") {
  journal.claimEffect(operation, { assistantEntryId: "assistant", toolIndex: 0, toolCallId: "call", toolName: "child", args: { mode }, replay: "never" });
}
process.send?.({ pid: process.pid, operationId: operation.id });
setInterval(() => {}, 1000);
`,
			);

			const child = spawn(process.execPath, [scriptPath, journalPath, "crash-session", mode], {
				stdio: ["ignore", "ignore", "pipe", "ipc"],
			});
			children.add(child);
			let stderr = "";
			child.stderr?.on("data", (chunk) => {
				stderr += chunk.toString();
			});
			const ready = await new Promise<{ pid: number; operationId: string }>((resolveReady, rejectReady) => {
				const timeout = setTimeout(() => rejectReady(new Error(`Child did not start: ${stderr}`)), 5_000);
				child.once("message", (message: unknown) => {
					clearTimeout(timeout);
					if (
						!message ||
						typeof message !== "object" ||
						!("pid" in message) ||
						typeof message.pid !== "number" ||
						!("operationId" in message) ||
						typeof message.operationId !== "string"
					) {
						rejectReady(new Error("Child returned an invalid ready message."));
						return;
					}
					resolveReady({ pid: message.pid, operationId: message.operationId });
				});
				child.once("exit", (code, signal) => {
					clearTimeout(timeout);
					rejectReady(new Error(`Child exited before ready (${code ?? signal}): ${stderr}`));
				});
			});
			const exit = once(child, "exit");
			expect(child.kill("SIGKILL")).toBe(true);
			const [code, signal] = await exit;
			children.delete(child);
			expect(code).toBeNull();
			expect(signal).toBe("SIGKILL");

			const restarted = new DurableOperationJournal(journalPath, "crash-session", { exclusive: true });
			try {
				const recovered = restarted.recoverInFlight();
				expect(recovered).toMatchObject({
					id: ready.operationId,
					status: "suspended",
					effects: expectedEffects.map((status) => ({ status })),
					processExits: [
						{
							kind: "unclean_exit",
							previousProcess: { pid: ready.pid },
							detectedBy: { pid: process.pid },
						},
					],
				});
				const processExit = recovered?.processExits[0];
				if (!processExit) throw new Error("Expected a process exit diagnostic.");
				expect(processExit.lastRecordSeq).toBeLessThan(processExit.seq);
			} finally {
				restarted.close();
			}
		},
		10_000,
	);
});
