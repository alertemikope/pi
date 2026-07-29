import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import { PiClient, type PiSessionClient } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import type { ModelMetadata, ModelRef } from "@earendil-works/pi-protocol";
import { PiServer } from "@earendil-works/pi-server";
import chalk from "chalk";
import { showStartupInput, showStartupSelector } from "../../cli/startup-ui.ts";
import { getAgentDir, VERSION } from "../../config.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { type ExperimentalCliArgs, parseExperimentalCliArgs } from "./args.ts";
import { ExperimentalPiSessionBackend } from "./backend.ts";
import { ExperimentalClientController } from "./client-controller.ts";
import { ExperimentalClientTui } from "./tui.ts";

const AUTH_TOKEN_ENV = "PI_SERVER_AUTH_TOKEN";
const NEW_SESSION_LABEL = "New session";

function printExperimentalHelp(): void {
	console.log(`pi experimental client/server mode

Usage:
  PI_EXPERIMENTAL=1 pi [options] [initial prompt]
  PI_EXPERIMENTAL=1 pi --client <socket-path> [options]
  PI_EXPERIMENTAL=1 pi --server <socket-path> [options]

Roles:
  no directional options          Start an in-process server and real Unix client
  --client <socket-path>           Connect to an existing Unix socket server
  --server <socket-path>           Run a foreground Unix socket server

Options:
  --auth-token <token>            Bearer token (or ${AUTH_TOKEN_ENV})
  --session <id>                  Attach a remote session
  --cwd <absolute-path>           Session cwd, or server default cwd in server role
  --provider <name>               Initial model provider
  --model <id|provider/id>        Initial model
  --thinking <level>              off|minimal|low|medium|high|xhigh|max
  --help, -h                      Show this help
  --version, -v                   Show version

Experimental mode is Unix-only, interactive, and text-only. --api-key, @files, print/json/rpc modes, and piped input are unsupported.`);
}

function generatedToken(): string {
	return randomBytes(32).toString("base64url");
}

function isAbsoluteServerPath(path: string): boolean {
	return posix.isAbsolute(path) || win32.isAbsolute(path);
}

function modelLabel(model: ModelMetadata): string {
	return `${model.provider}/${model.id}`;
}

function resolveRequestedModel(args: ExperimentalCliArgs, models: readonly ModelMetadata[]): ModelRef | undefined {
	if (!args.model) return undefined;
	let matches: ModelMetadata[];
	if (args.provider) {
		const modelId = args.model.startsWith(`${args.provider}/`)
			? args.model.slice(args.provider.length + 1)
			: args.model;
		matches = models.filter((model) => model.provider === args.provider && model.id === modelId);
	} else {
		const canonical = models.filter((model) => modelLabel(model) === args.model);
		matches = canonical.length > 0 ? canonical : models.filter((model) => model.id === args.model);
	}
	if (matches.length === 0) throw new Error(`Unknown server model: ${args.model}`);
	if (matches.length > 1) {
		throw new Error(`Ambiguous server model "${args.model}": ${matches.map(modelLabel).join(", ")}`);
	}
	const model = matches[0]!;
	if (!model.authenticated) throw new Error(`Server model is not authenticated: ${modelLabel(model)}`);
	if (args.thinking && !model.supportedThinkingLevels.includes(args.thinking)) {
		throw new Error(`Thinking level ${args.thinking} is not supported by ${modelLabel(model)}`);
	}
	return { provider: model.provider, id: model.id };
}

function sessionLabel(session: {
	id: string;
	name?: string;
	cwd: string;
	model: ModelRef;
	locked: boolean;
	attached: boolean;
}): string {
	const name = session.name?.trim() || session.id.slice(0, 8);
	const lock = session.locked && !session.attached ? " [locked]" : "";
	return `${name} · ${session.cwd} · ${session.model.provider}/${session.model.id} · ${session.id}${lock}`;
}

async function promptForRemoteCwd(settingsManager: SettingsManager): Promise<string | undefined> {
	for (;;) {
		const cwd = await showStartupInput(settingsManager, "Absolute working directory on the server", "/workspace");
		if (cwd === undefined) return undefined;
		if (isAbsoluteServerPath(cwd)) return cwd;
		console.error(chalk.red("Error: Server working directory must be absolute"));
	}
}

async function chooseClientOnlySession(
	client: PiClient,
	args: ExperimentalCliArgs,
	settingsManager: SettingsManager,
	model: ModelRef | undefined,
): Promise<PiSessionClient | undefined> {
	const sessions = await client.listSessions();
	const labels = sessions.map(sessionLabel);
	const selected = await showStartupSelector(settingsManager, "Select remote session", [
		{ label: NEW_SESSION_LABEL, value: -1 },
		...labels.map((label, index) => ({ label, value: index })),
	]);
	if (selected === undefined) return undefined;
	if (selected >= 0) {
		const summary = sessions[selected];
		if (!summary) throw new Error("Selected remote session no longer exists");
		return client.attachSession(summary.id);
	}
	const cwd = args.cwd ?? (await promptForRemoteCwd(settingsManager));
	if (!cwd) return undefined;
	return client.createSession({ cwd, model, thinkingLevel: args.thinking });
}

async function createController(
	client: PiClient,
	args: ExperimentalCliArgs,
	combined: boolean,
	settingsManager: SettingsManager,
): Promise<ExperimentalClientController | undefined> {
	const snapshot = await client.connect();
	const requestedModel = resolveRequestedModel(args, snapshot.models);
	let session: PiSessionClient | undefined;
	let created = false;
	if (args.session) {
		session = await client.attachSession(args.session);
	} else if (combined) {
		session = await client.createSession({
			cwd: args.cwd ?? process.cwd(),
			model: requestedModel,
			thinkingLevel: args.thinking,
		});
		created = true;
	} else {
		session = await chooseClientOnlySession(client, args, settingsManager, requestedModel);
		created = session !== undefined && !snapshot.sessions.some((candidate) => candidate.id === session?.id);
	}
	if (!session) {
		client.disconnect();
		return undefined;
	}
	const controller = new ExperimentalClientController(client);
	await controller.attachInitial(session);
	try {
		if (!created) {
			if (requestedModel) await controller.setModel(requestedModel);
			if (args.thinking) await controller.setThinking(args.thinking);
		}
	} catch (error) {
		await controller.dispose();
		throw error;
	}
	return controller;
}

async function runClient(
	args: ExperimentalCliArgs,
	socketPath: string,
	token: string,
	settingsManager: SettingsManager,
	combined: boolean,
): Promise<void> {
	const client = new PiClient({
		token,
		transportFactory: createUnixTransportFactory({ path: socketPath }),
	});
	let controller: ExperimentalClientController | undefined;
	try {
		controller = await createController(client, args, combined, settingsManager);
	} catch (error) {
		client.disconnect();
		throw error;
	}
	if (!controller) return;
	let tui: ExperimentalClientTui;
	try {
		tui = new ExperimentalClientTui(controller, settingsManager);
	} catch (error) {
		await controller.dispose();
		throw error;
	}
	const onSignal = () => void tui.shutdown();
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	try {
		await tui.run(args.initialPrompt);
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		await tui.shutdown();
	}
}

async function createServer(args: ExperimentalCliArgs, token: string, socketPath: string): Promise<PiServer> {
	const backend = await ExperimentalPiSessionBackend.create({ defaultCwd: resolve(args.cwd ?? process.cwd()) });
	const defaultModel = resolveRequestedModel(args, await backend.listModels());
	backend.setDefaultSessionOptions({ model: defaultModel, thinkingLevel: args.thinking });
	const server = new PiServer(backend, {
		token,
		unix: { path: socketPath },
		onError: (error) => console.error(chalk.red(`Server error: ${error.message}`)),
	});
	await server.start();
	return server;
}

async function waitForSignal(): Promise<void> {
	await new Promise<void>((resolvePromise) => {
		const finish = () => {
			process.off("SIGINT", finish);
			process.off("SIGTERM", finish);
			resolvePromise();
		};
		process.once("SIGINT", finish);
		process.once("SIGTERM", finish);
	});
}

async function runServerOnly(args: ExperimentalCliArgs): Promise<void> {
	const configuredToken = args.authToken ?? process.env[AUTH_TOKEN_ENV];
	const token = configuredToken || generatedToken();
	const server = await createServer(args, token, args.serverSocketPath!);
	console.log(`Listening: ${server.unixSocketPath}`);
	if (!configuredToken) console.log(`Auth token: ${token}`);
	try {
		await waitForSignal();
	} finally {
		await server.close();
	}
}

async function runCombined(args: ExperimentalCliArgs, settingsManager: SettingsManager): Promise<void> {
	const token = generatedToken();
	const directory = await mkdtemp(join(tmpdir(), "pi-experimental-"));
	const socketPath = join(directory, "p.sock");
	try {
		const server = await createServer(args, token, socketPath);
		try {
			await runClient(args, socketPath, token, settingsManager, true);
		} finally {
			await server.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

export async function runExperimentalClientServerCli(argv: readonly string[]): Promise<void> {
	const parsed = parseExperimentalCliArgs(argv);
	if (!parsed.args) {
		for (const error of parsed.errors) console.error(chalk.red(`Error: ${error}`));
		process.exitCode = 1;
		return;
	}
	const args = parsed.args;
	if (args.help) {
		printExperimentalHelp();
		return;
	}
	if (args.version) {
		console.log(VERSION);
		return;
	}
	if (process.platform === "win32") {
		console.error(chalk.red("Error: Experimental client/server mode currently requires Unix-domain sockets"));
		process.exitCode = 1;
		return;
	}
	if (process.stdin.isTTY === false) {
		console.error(chalk.red("Error: Piped input is not supported in experimental client/server mode"));
		process.exitCode = 1;
		return;
	}
	if (args.cwd && !isAbsoluteServerPath(args.cwd)) {
		console.error(chalk.red(`Error: --cwd must be an absolute server path: ${args.cwd}`));
		process.exitCode = 1;
		return;
	}

	const settingsSource = SettingsManager.create(process.cwd(), getAgentDir(), { projectTrusted: false });
	const settingsManager = SettingsManager.inMemory(settingsSource.getGlobalSettings(), { projectTrusted: false });
	try {
		if (args.role === "server") {
			await runServerOnly(args);
			return;
		}
		if (args.role === "client") {
			const token = args.authToken ?? process.env[AUTH_TOKEN_ENV];
			if (!token) throw new Error(`Client mode requires --auth-token or ${AUTH_TOKEN_ENV}`);
			await runClient(args, args.clientSocketPath!, token, settingsManager, false);
			return;
		}
		await runCombined(args, settingsManager);
	} catch (error) {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
		process.exitCode = 1;
	}
}

export { isAbsoluteServerPath, resolveRequestedModel };
