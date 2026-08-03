import { describe, expect, it } from "vitest";
import { runHostVerification } from "../src/core/verification.ts";

describe("runHostVerification", () => {
	it("creates host evidence for a passing check", async () => {
		const receipt = await runHostVerification(
			{ sessionId: "session", operationId: "operation", cwd: process.cwd() },
			{
				id: "unit",
				command: process.execPath,
				args: ["-e", "process.stdout.write('verified')"],
			},
		);

		expect(receipt).toMatchObject({
			criterionId: "unit",
			sessionId: "session",
			operationId: "operation",
			termination: { kind: "exited", code: 0 },
			verdict: "passed",
			stdout: { bytes: 8, excerpt: "verified", truncated: false },
		});
		expect(receipt.stdout.sha256).toMatch(/^[a-f0-9]{64}$/);
	});

	it("keeps exact output hashes while bounding persisted excerpts", async () => {
		const receipt = await runHostVerification(
			{ sessionId: "session", operationId: "operation", cwd: process.cwd() },
			{
				id: "bounded",
				command: process.execPath,
				args: ["-e", "process.stderr.write('abcdefgh')"],
				outputLimitBytes: 4,
			},
		);

		expect(receipt.stderr).toMatchObject({ bytes: 8, excerpt: "abcd", truncated: true });
	});

	it("fails checks on non-zero exit without losing the real code", async () => {
		const receipt = await runHostVerification(
			{ sessionId: "session", operationId: "operation", cwd: process.cwd() },
			{ id: "failure", command: process.execPath, args: ["-e", "process.exit(9)"] },
		);

		expect(receipt.verdict).toBe("failed");
		expect(receipt.termination).toEqual({ kind: "exited", code: 9 });
	});
});
