import { once } from "node:events";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	encodeClientMessage,
	PROTOCOL_VERSION,
	type ServerMessage,
	ServerMessageDecoder,
} from "@earendil-works/pi-protocol";
import { afterEach, expect, test } from "vitest";
import { PiServer, type PiSessionBackend } from "../src/index.ts";

const TOKEN = "transport-smoke-token";

const backend: PiSessionBackend = {
	async listSessions() {
		return [];
	},
	async listModels() {
		return [];
	},
	async createSession() {
		throw new Error("not used");
	},
	async openSession() {
		throw new Error("not used");
	},
};

let server: PiServer | undefined;
let socket: Socket | undefined;
let tempDirectory: string | undefined;

async function makeSocketPath(): Promise<string> {
	tempDirectory = await mkdtemp(join(tmpdir(), "pi-server-smoke-"));
	return join(tempDirectory, "server.sock");
}

afterEach(async () => {
	socket?.destroy();
	await server?.close();
	if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
	server = undefined;
	socket = undefined;
	tempDirectory = undefined;
});

test("requires an explicit Unix socket listener", () => {
	expect(() => Reflect.construct(PiServer, [backend, { token: TOKEN }])).toThrow(/Unix socket/);
});

test("rejects Unix socket paths that cannot fit in sockaddr_un", () => {
	expect(() => new PiServer(backend, { token: TOKEN, unix: { path: `/tmp/${"x".repeat(512)}` } })).toThrow(/too long/);
});

test("Unix socket accepts a fragmented framed-CBOR hello", async () => {
	const path = await makeSocketPath();
	server = new PiServer(backend, { token: TOKEN, unix: { path } });
	await server.start();
	expect(server.unixSocketPath).toBe(path);

	socket = createConnection(path);
	await once(socket, "connect");
	const response = nextServerMessage(socket);
	const hello = encodeClientMessage({ type: "hello", version: PROTOCOL_VERSION, token: TOKEN });
	socket.write(hello.subarray(0, 2));
	socket.write(hello.subarray(2));
	expect(await response).toMatchObject({ type: "hello", version: PROTOCOL_VERSION });
});

test("rejects concurrent start calls without leaking the Unix listener", async () => {
	const path = await makeSocketPath();
	server = new PiServer(backend, { token: TOKEN, unix: { path } });
	const starting = server.start();
	await expect(server.start()).rejects.toThrow(/starting/);
	await starting;
	await server.close();
	expect(server.unixSocketPath).toBeUndefined();
	await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("rejects pending-byte limits smaller than one maximum frame", async () => {
	const path = await makeSocketPath();
	expect(
		() => new PiServer(backend, { token: TOKEN, unix: { path }, maxFrameLength: 128, maxPendingBytes: 131 }),
	).toThrow(/maxPendingBytes/);
});

function nextServerMessage(target: Socket): Promise<ServerMessage> {
	const decoder = new ServerMessageDecoder();
	return new Promise((resolve, reject) => {
		const onData = (chunk: Buffer): void => {
			try {
				const messages = decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
				if (messages.length === 0) return;
				target.off("data", onData);
				resolve(messages[0]!);
			} catch (error) {
				reject(error);
			}
		};
		target.on("data", onData);
		target.once("error", reject);
	});
}
