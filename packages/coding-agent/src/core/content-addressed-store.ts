import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ContentAddressedBlobRef {
	algorithm: "sha256";
	digest: string;
	bytes: number;
}

export function isContentAddressedBlobRef(value: unknown): value is ContentAddressedBlobRef {
	return (
		!!value &&
		typeof value === "object" &&
		"algorithm" in value &&
		value.algorithm === "sha256" &&
		"digest" in value &&
		typeof value.digest === "string" &&
		/^[a-f0-9]{64}$/.test(value.digest) &&
		"bytes" in value &&
		typeof value.bytes === "number" &&
		Number.isSafeInteger(value.bytes) &&
		value.bytes >= 0
	);
}

export class ContentAddressedStore {
	readonly root: string;

	constructor(root: string) {
		this.root = resolve(root);
	}

	put(value: Uint8Array): ContentAddressedBlobRef {
		const bytes = Buffer.from(value);
		const digest = createHash("sha256").update(bytes).digest("hex");
		const ref: ContentAddressedBlobRef = { algorithm: "sha256", digest, bytes: bytes.length };
		const path = this.pathFor(ref);
		if (existsSync(path)) {
			this.verify(ref, readFileSync(path));
			return ref;
		}

		const directory = resolve(this.root, "sha256", digest.slice(0, 2));
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const temporaryPath = join(directory, `.${digest}.${process.pid}.${randomUUID()}.tmp`);
		try {
			writeFileSync(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
			try {
				chmodSync(temporaryPath, 0o600);
			} catch {
				// Some filesystems do not expose POSIX mode bits.
			}
			if (existsSync(path)) {
				this.verify(ref, readFileSync(path));
				return ref;
			}
			renameSync(temporaryPath, path);
			return ref;
		} finally {
			if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
		}
	}

	get(ref: ContentAddressedBlobRef): Buffer {
		if (!isContentAddressedBlobRef(ref)) throw new Error("Invalid content-addressed blob reference.");
		const value = readFileSync(this.pathFor(ref));
		this.verify(ref, value);
		return value;
	}

	private pathFor(ref: ContentAddressedBlobRef): string {
		if (!isContentAddressedBlobRef(ref)) throw new Error("Invalid content-addressed blob reference.");
		return resolve(this.root, "sha256", ref.digest.slice(0, 2), ref.digest.slice(2));
	}

	private verify(ref: ContentAddressedBlobRef, value: Uint8Array): void {
		const bytes = Buffer.from(value);
		const digest = createHash("sha256").update(bytes).digest("hex");
		if (bytes.length !== ref.bytes || digest !== ref.digest) {
			throw new Error(`Content-addressed blob ${ref.digest} failed integrity verification.`);
		}
	}
}
