import { createHash } from "node:crypto";
import type { ExecResult } from "@earendil-works/pi-coding-agent";

export interface GitCommandRunner {
	run(args: string[]): Promise<ExecResult>;
}

export interface GitWorkspaceState {
	repositoryRoot: string;
	gitDir: string;
	gitCommonDir: string;
	headOid?: string;
	statusHash: string;
	trackedDirty: boolean;
	untrackedCount: number;
	conflicted: boolean;
}

export interface GitOperationSnapshot extends GitWorkspaceState {
	coverage: "tracked-only";
	snapshotOid?: string;
	snapshotRef?: string;
}

function commandFailure(args: string[], result: ExecResult): Error {
	const detail = result.stderr.trim() || result.stdout.trim() || JSON.stringify(result.termination);
	return new Error(`git ${args.join(" ")} failed: ${detail}`);
}

async function runRequired(runner: GitCommandRunner, args: string[]): Promise<string> {
	const result = await runner.run(args);
	if (result.termination.kind !== "exited" || result.termination.code !== 0) {
		throw commandFailure(args, result);
	}
	return result.stdout.trim();
}

function refPart(value: string): string {
	const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	if (!normalized || normalized === "." || normalized === ".." || normalized.endsWith(".lock")) {
		throw new Error(`Cannot encode Git snapshot ref component: ${value}`);
	}
	return normalized;
}

export async function inspectGitWorkspace(runner: GitCommandRunner): Promise<GitWorkspaceState> {
	const [repositoryRoot, gitDir, gitCommonDir, status] = await Promise.all([
		runRequired(runner, ["rev-parse", "--show-toplevel"]),
		runRequired(runner, ["rev-parse", "--absolute-git-dir"]),
		runRequired(runner, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
		runRequired(runner, ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all"]),
	]);
	const headResult = await runner.run(["rev-parse", "--verify", "HEAD"]);
	const headOid =
		headResult.termination.kind === "exited" && headResult.termination.code === 0
			? headResult.stdout.trim()
			: undefined;
	const records = status.split("\0").filter(Boolean);
	return {
		repositoryRoot,
		gitDir,
		gitCommonDir,
		headOid,
		statusHash: createHash("sha256").update(status).digest("hex"),
		trackedDirty: records.some(
			(record) => record.startsWith("1 ") || record.startsWith("2 ") || record.startsWith("u "),
		),
		untrackedCount: records.filter((record) => record.startsWith("? ")).length,
		conflicted: records.some((record) => record.startsWith("u ")),
	};
}

export async function captureGitOperationSnapshot(
	runner: GitCommandRunner,
	identity: { sessionId: string; operationId: string },
): Promise<GitOperationSnapshot> {
	const state = await inspectGitWorkspace(runner);
	if (state.conflicted) {
		throw new Error("Cannot create a reliable Git operation snapshot while the index contains conflicts.");
	}
	if (!state.headOid || !state.trackedDirty) {
		return { ...state, coverage: "tracked-only" };
	}

	const snapshotOid = await runRequired(runner, ["stash", "create", `pi operation ${identity.operationId}`]);
	if (!/^[a-f0-9]{40,64}$/.test(snapshotOid)) {
		throw new Error("Git returned an invalid operation snapshot object id.");
	}
	await runRequired(runner, ["cat-file", "-e", `${snapshotOid}^{commit}`]);
	const objectFormat = await runRequired(runner, ["rev-parse", "--show-object-format"]);
	const zeroOid = objectFormat === "sha256" ? "0".repeat(64) : "0".repeat(40);
	const snapshotRef = `refs/pi/operation-snapshots/${refPart(identity.sessionId)}/${refPart(identity.operationId)}`;
	await runRequired(runner, ["check-ref-format", snapshotRef]);
	await runRequired(runner, ["update-ref", snapshotRef, snapshotOid, zeroOid]);
	return { ...state, coverage: "tracked-only", snapshotOid, snapshotRef };
}
