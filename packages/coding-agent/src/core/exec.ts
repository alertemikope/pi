/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { spawn } from "node:child_process";
import { waitForChildProcess } from "../utils/child-process.ts";

/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
	/** AbortSignal to cancel the command */
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Working directory */
	cwd?: string;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	termination: ProcessTermination;
	/** @deprecated Use termination. Preserved for extension compatibility. */
	code: number;
	/** @deprecated Use termination. Preserved for extension compatibility. */
	killed: boolean;
}

export type ProcessTermination =
	| { kind: "exited"; code: number }
	| { kind: "signaled"; signal: NodeJS.Signals | null }
	| { kind: "aborted" }
	| { kind: "timed_out"; timeoutMs: number }
	| { kind: "spawn_error"; message: string };

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout and abort signal.
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let killed = false;
		let timeoutId: NodeJS.Timeout | undefined;
		let forceKillId: NodeJS.Timeout | undefined;
		let requestedTermination: Extract<ProcessTermination, { kind: "aborted" | "timed_out" }> | undefined;
		let exitSignal: NodeJS.Signals | null = null;
		let spawnError: Error | undefined;

		const killProcess = (termination: Extract<ProcessTermination, { kind: "aborted" | "timed_out" }>) => {
			if (!killed) {
				killed = true;
				requestedTermination = termination;
				proc.kill("SIGTERM");
				// Force kill after 5 seconds if SIGTERM doesn't work
				forceKillId = setTimeout(() => {
					if (proc.exitCode === null && proc.signalCode === null) {
						proc.kill("SIGKILL");
					}
				}, 5000);
			}
		};
		const abortProcess = () => killProcess({ kind: "aborted" });
		proc.once("exit", (_code, signal) => {
			exitSignal = signal;
		});
		proc.once("error", (error) => {
			spawnError = error;
		});

		// Handle abort signal
		if (options?.signal) {
			if (options.signal.aborted) {
				abortProcess();
			} else {
				options.signal.addEventListener("abort", abortProcess, { once: true });
			}
		}

		// Handle timeout
		const timeoutMs = options?.timeout;
		if (timeoutMs && timeoutMs > 0) {
			timeoutId = setTimeout(() => {
				killProcess({ kind: "timed_out", timeoutMs });
			}, timeoutMs);
		}

		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		// Wait for process termination without hanging on inherited stdio handles
		// held open by detached descendants.
		waitForChildProcess(proc)
			.then((code) => {
				if (timeoutId) clearTimeout(timeoutId);
				if (forceKillId) clearTimeout(forceKillId);
				if (options?.signal) {
					options.signal.removeEventListener("abort", abortProcess);
				}
				const termination: ProcessTermination =
					requestedTermination ??
					(spawnError
						? { kind: "spawn_error", message: spawnError.message }
						: code === null
							? { kind: "signaled", signal: exitSignal }
							: { kind: "exited", code });
				resolve({
					stdout,
					stderr,
					termination,
					code: termination.kind === "exited" ? termination.code : 1,
					killed,
				});
			})
			.catch((error: unknown) => {
				if (timeoutId) clearTimeout(timeoutId);
				if (forceKillId) clearTimeout(forceKillId);
				if (options?.signal) {
					options.signal.removeEventListener("abort", abortProcess);
				}
				const message = error instanceof Error ? error.message : String(error);
				resolve({
					stdout,
					stderr,
					termination: requestedTermination ?? { kind: "spawn_error", message },
					code: 1,
					killed,
				});
			});
	});
}
