import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContentAddressedStore } from "../src/core/content-addressed-store.ts";

describe("ContentAddressedStore", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	it("deduplicates identical bytes and verifies reads", () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-cas-"));
		const store = new ContentAddressedStore(tempDir);
		const first = store.put(Buffer.from("payload"));
		const second = store.put(Buffer.from("payload"));

		expect(second).toEqual(first);
		expect(store.get(first).toString("utf8")).toBe("payload");
	});

	it("rejects a blob whose bytes no longer match its reference", () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-cas-"));
		const store = new ContentAddressedStore(tempDir);
		const ref = store.put(Buffer.from("original"));
		const blobPath = join(tempDir, "sha256", ref.digest.slice(0, 2), ref.digest.slice(2));
		writeFileSync(blobPath, "tampered");

		expect(() => store.get(ref)).toThrow(/failed integrity verification/);
	});
});
