import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireDurableOperationLease } from "../src/core/durable-operations.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import {
	renameInactiveSessionFile,
	SessionSelectorComponent,
} from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

function makeSession(overrides: Partial<SessionInfo> & { id: string }): SessionInfo {
	return {
		path: overrides.path ?? `/tmp/${overrides.id}.jsonl`,
		id: overrides.id,
		cwd: overrides.cwd ?? "",
		name: overrides.name,
		created: overrides.created ?? new Date(0),
		modified: overrides.modified ?? new Date(0),
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.firstMessage ?? "hello",
		allMessagesText: overrides.allMessagesText ?? "hello",
	};
}

// Kitty keyboard protocol encoding for Ctrl+R
const CTRL_R = "\x1b[114;5u";

describe("session selector rename", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		// Ensure test isolation: keybindings are a global singleton
		setKeybindings(new KeybindingsManager());
	});

	it("shows rename hint in interactive /resume picker configuration", async () => {
		const sessions = [makeSession({ id: "a" })];
		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ showRenameHint: true, keybindings },
		);
		await flushPromises();

		const output = selector.render(120).join("\n");
		expect(output).toContain("ctrl+r");
		expect(output).toContain("rename");
	});

	it("does not show rename hint in --resume picker configuration", async () => {
		const sessions = [makeSession({ id: "a" })];
		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ showRenameHint: false, keybindings },
		);
		await flushPromises();

		const output = selector.render(120).join("\n");
		expect(output).not.toContain("ctrl+r");
		expect(output).not.toContain("rename");
	});

	it("enters rename mode on Ctrl+R and submits with Enter", async () => {
		const sessions = [makeSession({ id: "a", name: "Old" })];
		const renameSession = vi.fn(async () => {});

		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ renameSession, showRenameHint: true, keybindings },
		);
		await flushPromises();

		selector.getSessionList().handleInput(CTRL_R);
		await flushPromises();

		// Rename mode layout
		const output = selector.render(120).join("\n");
		expect(output).toContain("Rename Session");
		expect(output).not.toContain("Resume Session");

		// Type and submit
		selector.handleInput("X");
		selector.handleInput("\r");
		await flushPromises();

		expect(renameSession).toHaveBeenCalledTimes(1);
		expect(renameSession).toHaveBeenCalledWith(sessions[0]!.path, "XOld");
	});

	it("shows rename failures and exits rename mode", async () => {
		const sessions = [makeSession({ id: "a", name: "Old" })];
		const renameSession = vi.fn(async () => {
			throw new Error("Session is already open for durable writes");
		});

		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ renameSession, showRenameHint: true, keybindings },
		);
		await flushPromises();

		selector.getSessionList().handleInput(CTRL_R);
		await flushPromises();
		selector.handleInput("X");
		selector.handleInput("\r");
		await flushPromises();

		const output = selector.render(120).join("\n");
		expect(output).toContain("Resume Session");
		expect(output).toContain("Failed to rename: Session is already open for durable writes");
	});

	it("renames an inactive session while holding its writer lease", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-rename-"));
		tempDirs.push(dir);
		const sessionPath = join(dir, "session.jsonl");
		writeFileSync(
			sessionPath,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "rename-session",
				timestamp: new Date().toISOString(),
				cwd: dir,
			})}\n`,
		);

		renameInactiveSessionFile(sessionPath, "Renamed");

		expect(readFileSync(sessionPath, "utf8")).toContain('"type":"session_info"');
		expect(readFileSync(sessionPath, "utf8")).toContain('"name":"Renamed"');
		expect(existsSync(`${sessionPath}.operations.jsonl.lock`)).toBe(false);
	});

	it("does not mutate an inactive session locked by another writer", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-rename-locked-"));
		tempDirs.push(dir);
		const sessionPath = join(dir, "session.jsonl");
		const original = `${JSON.stringify({
			type: "session",
			version: 3,
			id: "locked-session",
			timestamp: new Date().toISOString(),
			cwd: dir,
		})}\n`;
		writeFileSync(sessionPath, original);
		const lease = acquireDurableOperationLease(`${sessionPath}.operations.jsonl`);

		try {
			expect(() => renameInactiveSessionFile(sessionPath, "Must Not Persist")).toThrow(
				"already open for durable writes",
			);
			expect(readFileSync(sessionPath, "utf8")).toBe(original);
		} finally {
			lease.release();
		}
	});
});
