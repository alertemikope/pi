import { describe, expect, it } from "vitest";
import { execCommand } from "../src/core/exec.ts";

describe("execCommand", () => {
	it("reports normal exits without collapsing the exit code", async () => {
		const result = await execCommand(process.execPath, ["-e", "process.exit(7)"], process.cwd());

		expect(result.termination).toEqual({ kind: "exited", code: 7 });
		expect(result.code).toBe(7);
		expect(result.killed).toBe(false);
	});

	it("distinguishes timeout from a process signal", async () => {
		const result = await execCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], process.cwd(), {
			timeout: 20,
		});

		expect(result.termination).toEqual({ kind: "timed_out", timeoutMs: 20 });
		expect(result.killed).toBe(true);
	});

	it("distinguishes caller abort from timeout", async () => {
		const controller = new AbortController();
		const execution = execCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], process.cwd(), {
			signal: controller.signal,
		});
		controller.abort();

		expect((await execution).termination).toEqual({ kind: "aborted" });
	});

	it("reports spawn errors instead of treating them as exit zero", async () => {
		const result = await execCommand(`missing-pi-command-${Date.now()}`, [], process.cwd());

		expect(result.termination).toMatchObject({ kind: "spawn_error" });
		expect(result.code).toBe(1);
	});
});
