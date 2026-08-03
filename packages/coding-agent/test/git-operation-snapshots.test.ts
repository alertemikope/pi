import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	captureGitOperationSnapshot,
	inspectGitWorkspace,
} from "../examples/extensions/git-operation-snapshots/git.ts";
import { type ExecResult, execCommand } from "../src/core/exec.ts";

describe("Git operation snapshots", () => {
	let repository: string;

	async function git(args: string[]): Promise<ExecResult> {
		return await execCommand("git", args, repository);
	}

	async function required(args: string[]): Promise<string> {
		const result = await git(args);
		if (result.termination.kind !== "exited" || result.termination.code !== 0) {
			throw new Error(result.stderr || JSON.stringify(result.termination));
		}
		return result.stdout.trim();
	}

	beforeEach(async () => {
		repository = mkdtempSync(join(tmpdir(), "pi-git-snapshot-"));
		await required(["init"]);
		await required(["config", "user.name", "Pi Test"]);
		await required(["config", "user.email", "pi@example.invalid"]);
		writeFileSync(join(repository, "tracked.txt"), "base\n");
		await required(["add", "tracked.txt"]);
		await required(["commit", "-m", "base"]);
	});

	afterEach(() => {
		rmSync(repository, { recursive: true, force: true });
	});

	it("anchors tracked state without changing the worktree, index, or user stash", async () => {
		writeFileSync(join(repository, "tracked.txt"), "staged\n");
		await required(["add", "tracked.txt"]);
		writeFileSync(join(repository, "tracked.txt"), "working\n");
		writeFileSync(join(repository, "untracked.txt"), "outside snapshot\n");
		const statusBefore = await required([
			"--no-optional-locks",
			"status",
			"--porcelain=v2",
			"-z",
			"--untracked-files=all",
		]);

		const snapshot = await captureGitOperationSnapshot(
			{ run: git },
			{ sessionId: "session-1", operationId: "operation-1" },
		);

		expect(snapshot).toMatchObject({
			coverage: "tracked-only",
			trackedDirty: true,
			untrackedCount: 1,
			conflicted: false,
		});
		expect(snapshot.snapshotOid).toMatch(/^[a-f0-9]{40,64}$/);
		expect(snapshot.snapshotRef).toBe("refs/pi/operation-snapshots/session-1/operation-1");
		expect(await required(["rev-parse", snapshot.snapshotRef!])).toBe(snapshot.snapshotOid);
		expect(await required(["show", `${snapshot.snapshotOid}:tracked.txt`])).toBe("working");
		expect(await required(["show", `${snapshot.snapshotOid}^2:tracked.txt`])).toBe("staged");
		expect(await required(["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all"])).toBe(
			statusBefore,
		);
		expect(readFileSync(join(repository, "tracked.txt"), "utf8")).toBe("working\n");
		expect((await git(["rev-parse", "--verify", "refs/stash"])).termination).toMatchObject({
			kind: "exited",
			code: 128,
		});
	});

	it("reports untracked-only state without inventing a tracked snapshot", async () => {
		writeFileSync(join(repository, "untracked.txt"), "not covered\n");

		const state = await inspectGitWorkspace({ run: git });
		const snapshot = await captureGitOperationSnapshot(
			{ run: git },
			{ sessionId: "session-2", operationId: "operation-2" },
		);

		expect(state).toMatchObject({ trackedDirty: false, untrackedCount: 1, conflicted: false });
		expect(snapshot).toMatchObject({ coverage: "tracked-only", trackedDirty: false, untrackedCount: 1 });
		expect(snapshot.snapshotOid).toBeUndefined();
		expect(snapshot.snapshotRef).toBeUndefined();
	});
});
