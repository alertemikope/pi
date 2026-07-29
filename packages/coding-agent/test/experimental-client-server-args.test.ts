import { describe, expect, test } from "vitest";
import { parseExperimentalCliArgs } from "../src/experimental/client-server/args.ts";

describe("experimental client/server CLI parser", () => {
	test("selects combined mode when no directional options are present", () => {
		const result = parseExperimentalCliArgs(["--cwd", "/workspace", "inspect", "the", "project"]);
		expect(result.errors).toEqual([]);
		expect(result.args).toMatchObject({
			role: "combined",
			cwd: "/workspace",
			initialPrompt: "inspect the project",
		});
	});

	test("selects client mode with an absolute Unix socket path", () => {
		const result = parseExperimentalCliArgs([
			"--client",
			"/tmp/pi.sock",
			"--auth-token=secret",
			"--session",
			"session-1",
			"--model",
			"provider/model",
			"--thinking",
			"high",
		]);
		expect(result.errors).toEqual([]);
		expect(result.args).toMatchObject({
			role: "client",
			clientSocketPath: "/tmp/pi.sock",
			authToken: "secret",
			session: "session-1",
			model: "provider/model",
			thinking: "high",
		});
	});

	test("selects server mode with an absolute Unix socket path", () => {
		const result = parseExperimentalCliArgs(["--server", "/tmp/pi.sock"]);
		expect(result.errors).toEqual([]);
		expect(result.args).toMatchObject({ role: "server", serverSocketPath: "/tmp/pi.sock" });
	});

	test("rejects an auth token without a directional role", () => {
		const result = parseExperimentalCliArgs(["--auth-token", "secret"]);
		expect(result.args).toBeUndefined();
		expect(result.errors).toContain("--auth-token alone does not select a role; use --client or --server");
	});

	test("rejects mixed client and server directions", () => {
		const result = parseExperimentalCliArgs(["--client", "/tmp/client.sock", "--server", "/tmp/server.sock"]);
		expect(result.args).toBeUndefined();
		expect(result.errors).toContain("--client cannot be combined with --server");
	});

	test.each([
		[["--api-key", "secret"], "--api-key is not supported"],
		[["@prompt.md"], "@file arguments are not supported"],
		[["--print", "hello"], "--print is not supported"],
		[["--mode", "json"], "--mode (text/json/rpc) is not supported"],
		[["--listen", "127.0.0.1"], "Unknown or unsupported option: --listen"],
		[["--port", "1234"], "Unknown or unsupported option: --port"],
		[["--tls-cert", "cert.pem"], "Unknown or unsupported option: --tls-cert"],
		[["--allow-insecure"], "Unknown or unsupported option: --allow-insecure"],
		[["--unknown"], "Unknown or unsupported option: --unknown"],
	] as const)("rejects unsupported input %j", (argv, message) => {
		const result = parseExperimentalCliArgs(argv);
		expect(result.args).toBeUndefined();
		expect(result.errors.some((error) => error.includes(message))).toBe(true);
	});

	test("allows server model defaults but rejects client-only session selection and prompts", () => {
		const result = parseExperimentalCliArgs([
			"--server",
			"/tmp/pi.sock",
			"--provider",
			"faux",
			"--model",
			"one",
			"--session",
			"old",
			"hello",
		]);
		expect(result.args).toBeUndefined();
		expect(result.errors).toContain("An initial prompt is only valid for client or combined roles");
		expect(result.errors).toContain("--session is only valid for client or combined roles");
	});

	test("validates socket paths, required values, and thinking levels", () => {
		expect(parseExperimentalCliArgs(["--client", "relative.sock"]).errors).toContain(
			"--client requires an absolute Unix socket path",
		);
		expect(parseExperimentalCliArgs(["--server", "relative.sock"]).errors).toContain(
			"--server requires an absolute Unix socket path",
		);
		expect(parseExperimentalCliArgs(["--server"]).errors).toContain("--server requires a value");
		expect(parseExperimentalCliArgs(["--thinking", "extreme"]).errors[0]).toContain("Invalid thinking level");
	});
});
