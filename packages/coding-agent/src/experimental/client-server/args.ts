import { posix } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-protocol";

export type ExperimentalCliRole = "combined" | "client" | "server";

export interface ExperimentalCliArgs {
	role: ExperimentalCliRole;
	clientSocketPath?: string;
	serverSocketPath?: string;
	authToken?: string;
	session?: string;
	cwd?: string;
	provider?: string;
	model?: string;
	thinking?: ThinkingLevel;
	help: boolean;
	version: boolean;
	initialPrompt?: string;
}

export interface ExperimentalCliParseResult {
	args?: ExperimentalCliArgs;
	errors: string[];
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const VALUE_OPTIONS = new Set([
	"--client",
	"--server",
	"--auth-token",
	"--session",
	"--cwd",
	"--provider",
	"--model",
	"--thinking",
]);

function isThinkingLevel(value: string): value is ThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

function splitOption(argument: string): { option: string; inlineValue?: string } {
	const equals = argument.indexOf("=");
	return equals === -1
		? { option: argument }
		: { option: argument.slice(0, equals), inlineValue: argument.slice(equals + 1) };
}

export function parseExperimentalCliArgs(argv: readonly string[]): ExperimentalCliParseResult {
	const errors: string[] = [];
	const positional: string[] = [];
	let clientSocketPath: string | undefined;
	let serverSocketPath: string | undefined;
	let authToken: string | undefined;
	let authTokenExplicit = false;
	let session: string | undefined;
	let cwd: string | undefined;
	let provider: string | undefined;
	let model: string | undefined;
	let thinking: ThinkingLevel | undefined;
	let help = false;
	let version = false;
	let parsePositionalsOnly = false;

	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index]!;
		if (parsePositionalsOnly) {
			if (argument.startsWith("@")) errors.push("@file arguments are not supported in experimental mode");
			else positional.push(argument);
			continue;
		}
		if (argument === "--") {
			parsePositionalsOnly = true;
			continue;
		}
		if (argument.startsWith("@")) {
			errors.push("@file arguments are not supported in experimental mode");
			continue;
		}
		if (!argument.startsWith("-")) {
			positional.push(argument);
			continue;
		}

		const { option, inlineValue } = splitOption(argument);
		if (option === "--help" || option === "-h") {
			help = true;
			continue;
		}
		if (option === "--version" || option === "-v") {
			version = true;
			continue;
		}
		if (option === "--print" || option === "-p" || option === "--json" || option === "--rpc") {
			errors.push(`${option} is not supported in experimental client/server mode`);
			continue;
		}
		if (option === "--mode") {
			if (inlineValue === undefined && argv[index + 1] !== undefined) index++;
			errors.push("--mode (text/json/rpc) is not supported in experimental client/server mode");
			continue;
		}
		if (option === "--api-key") {
			if (inlineValue === undefined && argv[index + 1] !== undefined && !argv[index + 1]!.startsWith("-")) index++;
			errors.push("--api-key is not supported; credentials are owned by the server");
			continue;
		}
		if (!VALUE_OPTIONS.has(option)) {
			errors.push(`Unknown or unsupported option: ${option}`);
			continue;
		}

		let value = inlineValue;
		if (value === undefined) {
			const next = argv[index + 1];
			if (next !== undefined && !next.startsWith("-")) {
				value = next;
				index++;
			}
		}
		if (value === undefined || value === "") {
			errors.push(`${option} requires a value`);
			continue;
		}

		switch (option) {
			case "--client":
				clientSocketPath = value;
				break;
			case "--server":
				serverSocketPath = value;
				break;
			case "--auth-token":
				authToken = value;
				authTokenExplicit = true;
				break;
			case "--session":
				session = value;
				break;
			case "--cwd":
				cwd = value;
				break;
			case "--provider":
				provider = value;
				break;
			case "--model":
				model = value;
				break;
			case "--thinking":
				if (isThinkingLevel(value)) thinking = value;
				else errors.push(`Invalid thinking level "${value}". Valid values: ${THINKING_LEVELS.join(", ")}`);
				break;
		}
	}

	let role: ExperimentalCliRole;
	if (clientSocketPath !== undefined && serverSocketPath !== undefined) {
		errors.push("--client cannot be combined with --server");
		role = "client";
	} else if (clientSocketPath !== undefined) {
		role = "client";
	} else if (serverSocketPath !== undefined) {
		role = "server";
	} else {
		role = "combined";
	}

	if (role === "combined" && authTokenExplicit) {
		errors.push("--auth-token alone does not select a role; use --client or --server");
	}
	if (role === "server") {
		if (session !== undefined) errors.push("--session is only valid for client or combined roles");
		if (positional.length > 0) errors.push("An initial prompt is only valid for client or combined roles");
	}
	if (provider !== undefined && model === undefined) errors.push("--provider requires --model");
	if (clientSocketPath !== undefined && !posix.isAbsolute(clientSocketPath)) {
		errors.push("--client requires an absolute Unix socket path");
	}
	if (serverSocketPath !== undefined && !posix.isAbsolute(serverSocketPath)) {
		errors.push("--server requires an absolute Unix socket path");
	}

	if (errors.length > 0) return { errors };
	return {
		args: {
			role,
			clientSocketPath,
			serverSocketPath,
			authToken,
			session,
			cwd,
			provider,
			model,
			thinking,
			help,
			version,
			initialPrompt: positional.length > 0 ? positional.join(" ") : undefined,
		},
		errors,
	};
}
