const UINT32_BASE = 0x1_0000_0000;
const MAX_UINT32 = 0xffff_ffff;
const MAX_CONFIGURED_DEPTH = 512;

/** Safe defaults for untrusted protocol payloads. */
export const DEFAULT_MAX_CBOR_BYTE_LENGTH = 16 * 1024 * 1024;
export const DEFAULT_MAX_CBOR_CONTAINER_LENGTH = 1_000_000;
export const DEFAULT_MAX_CBOR_DEPTH = 64;

export interface CborOptions {
	/** Maximum encoded input/output bytes and maximum byte/text string length. */
	maxByteLength?: number;
	/** Maximum number of elements in an array or entries in a map. */
	maxContainerLength?: number;
	/** Maximum recursive item depth. */
	maxDepth?: number;
}

interface ResolvedCborOptions {
	maxByteLength: number;
	maxContainerLength: number;
	maxDepth: number;
}

export class CborError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CborError";
	}
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function resolveLimit(name: string, value: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
		throw new RangeError(`${name} must be an integer between 0 and ${maximum}`);
	}
	return value;
}

function resolveOptions(options: CborOptions | undefined): ResolvedCborOptions {
	return {
		maxByteLength: resolveLimit("maxByteLength", options?.maxByteLength ?? DEFAULT_MAX_CBOR_BYTE_LENGTH, MAX_UINT32),
		maxContainerLength: resolveLimit(
			"maxContainerLength",
			options?.maxContainerLength ?? DEFAULT_MAX_CBOR_CONTAINER_LENGTH,
			MAX_UINT32,
		),
		maxDepth: resolveLimit("maxDepth", options?.maxDepth ?? DEFAULT_MAX_CBOR_DEPTH, MAX_CONFIGURED_DEPTH),
	};
}

class CborWriter {
	private buffer: Uint8Array;
	private offset = 0;
	private readonly maxByteLength: number;

	constructor(maxByteLength: number) {
		this.maxByteLength = maxByteLength;
		this.buffer = new Uint8Array(Math.min(256, maxByteLength));
	}

	writeByte(value: number): void {
		this.ensureCapacity(1);
		this.buffer[this.offset] = value;
		this.offset++;
	}

	writeBytes(bytes: Uint8Array): void {
		this.ensureCapacity(bytes.byteLength);
		this.buffer.set(bytes, this.offset);
		this.offset += bytes.byteLength;
	}

	writeUint16(value: number): void {
		this.ensureCapacity(2);
		this.buffer[this.offset] = value >>> 8;
		this.buffer[this.offset + 1] = value;
		this.offset += 2;
	}

	writeUint32(value: number): void {
		this.ensureCapacity(4);
		this.buffer[this.offset] = value >>> 24;
		this.buffer[this.offset + 1] = value >>> 16;
		this.buffer[this.offset + 2] = value >>> 8;
		this.buffer[this.offset + 3] = value;
		this.offset += 4;
	}

	writeUint64(value: number): void {
		const high = Math.floor(value / UINT32_BASE);
		const low = value - high * UINT32_BASE;
		this.writeUint32(high);
		this.writeUint32(low);
	}

	writeFloat64(value: number): void {
		this.ensureCapacity(9);
		this.buffer[this.offset] = 0xfb;
		new DataView(this.buffer.buffer).setFloat64(this.offset + 1, value, false);
		this.offset += 9;
	}

	finish(): Uint8Array {
		return this.buffer.slice(0, this.offset);
	}

	private ensureCapacity(additionalBytes: number): void {
		const required = this.offset + additionalBytes;
		if (required > this.maxByteLength) {
			throw new CborError(`CBOR byte length exceeds configured limit of ${this.maxByteLength}`);
		}
		if (required <= this.buffer.byteLength) return;

		let capacity = Math.max(1, this.buffer.byteLength);
		while (capacity < required) capacity = Math.min(this.maxByteLength, Math.max(required, capacity * 2));
		const expanded = new Uint8Array(capacity);
		expanded.set(this.buffer);
		this.buffer = expanded;
	}
}

function writeArgument(writer: CborWriter, majorType: number, value: number): void {
	const prefix = majorType << 5;
	if (value < 24) {
		writer.writeByte(prefix | value);
	} else if (value <= 0xff) {
		writer.writeByte(prefix | 24);
		writer.writeByte(value);
	} else if (value <= 0xffff) {
		writer.writeByte(prefix | 25);
		writer.writeUint16(value);
	} else if (value <= MAX_UINT32) {
		writer.writeByte(prefix | 26);
		writer.writeUint32(value);
	} else {
		writer.writeByte(prefix | 27);
		writer.writeUint64(value);
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function encodeText(writer: CborWriter, value: string, options: ResolvedCborOptions): void {
	const bytes = textEncoder.encode(value);
	if (bytes.byteLength > options.maxByteLength) {
		throw new CborError(`CBOR text string length exceeds configured limit of ${options.maxByteLength}`);
	}
	if (textDecoder.decode(bytes) !== value)
		throw new CborError("CBOR text strings must contain valid Unicode scalar values");
	writeArgument(writer, 3, bytes.byteLength);
	writer.writeBytes(bytes);
}

function encodeValue(
	writer: CborWriter,
	value: unknown,
	options: ResolvedCborOptions,
	depth: number,
	ancestors: Set<object>,
): void {
	if (depth > options.maxDepth)
		throw new CborError(`CBOR nesting depth exceeds configured limit of ${options.maxDepth}`);

	if (value === null) {
		writer.writeByte(0xf6);
		return;
	}
	if (typeof value === "boolean") {
		writer.writeByte(value ? 0xf5 : 0xf4);
		return;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new CborError("CBOR numbers must be finite");
		if (Number.isInteger(value) && !Object.is(value, -0)) {
			if (!Number.isSafeInteger(value)) throw new CborError("CBOR integers must be safe JavaScript integers");
			if (value >= 0) writeArgument(writer, 0, value);
			else writeArgument(writer, 1, -1 - value);
		} else {
			writer.writeFloat64(value);
		}
		return;
	}
	if (typeof value === "string") {
		encodeText(writer, value, options);
		return;
	}
	if (value instanceof Uint8Array) {
		if (value.byteLength > options.maxByteLength) {
			throw new CborError(`CBOR byte string length exceeds configured limit of ${options.maxByteLength}`);
		}
		writeArgument(writer, 2, value.byteLength);
		writer.writeBytes(value);
		return;
	}
	if (Array.isArray(value)) {
		if (ancestors.has(value)) throw new CborError("CBOR values must not contain cycles");
		if (value.length > options.maxContainerLength) {
			throw new CborError(`CBOR array length exceeds configured limit of ${options.maxContainerLength}`);
		}
		ancestors.add(value);
		try {
			writeArgument(writer, 4, value.length);
			for (let index = 0; index < value.length; index++) {
				if (!Object.hasOwn(value, index) || value[index] === undefined) {
					throw new CborError("CBOR arrays must not contain holes or undefined values");
				}
				encodeValue(writer, value[index], options, depth + 1, ancestors);
			}
		} finally {
			ancestors.delete(value);
		}
		return;
	}
	if (isPlainObject(value)) {
		if (ancestors.has(value)) throw new CborError("CBOR values must not contain cycles");
		for (const symbol of Object.getOwnPropertySymbols(value)) {
			if (Object.prototype.propertyIsEnumerable.call(value, symbol)) {
				throw new CborError("CBOR map keys must be strings");
			}
		}
		const entries: Array<readonly [string, unknown]> = [];
		for (const key of Object.keys(value)) {
			const entryValue = value[key];
			if (entryValue !== undefined) entries.push([key, entryValue]);
		}
		if (entries.length > options.maxContainerLength) {
			throw new CborError(`CBOR map length exceeds configured limit of ${options.maxContainerLength}`);
		}
		ancestors.add(value);
		try {
			writeArgument(writer, 5, entries.length);
			for (const [key, entryValue] of entries) {
				encodeText(writer, key, options);
				encodeValue(writer, entryValue, options, depth + 1, ancestors);
			}
		} finally {
			ancestors.delete(value);
		}
		return;
	}

	throw new CborError(`Unsupported CBOR value type: ${typeof value}`);
}

/** Encodes the protocol's strict, definite-length RFC 8949 subset. */
export function encodeCbor(value: unknown, options?: CborOptions): Uint8Array {
	const resolved = resolveOptions(options);
	const writer = new CborWriter(resolved.maxByteLength);
	encodeValue(writer, value, resolved, 0, new Set<object>());
	return writer.finish();
}

class CborReader {
	private readonly bytes: Uint8Array;
	private offset = 0;
	private readonly options: ResolvedCborOptions;

	constructor(bytes: Uint8Array, options: ResolvedCborOptions) {
		this.bytes = bytes;
		this.options = options;
	}

	decode(): unknown {
		const value = this.readItem(0);
		if (this.offset !== this.bytes.byteLength) throw new CborError("CBOR payload contains trailing data");
		return value;
	}

	private readItem(depth: number): unknown {
		if (depth > this.options.maxDepth) {
			throw new CborError(`CBOR nesting depth exceeds configured limit of ${this.options.maxDepth}`);
		}
		const initial = this.readByte();
		const majorType = initial >>> 5;
		const additionalInformation = initial & 0x1f;

		switch (majorType) {
			case 0:
				return this.readArgument(additionalInformation);
			case 1: {
				const value = -1 - this.readArgument(additionalInformation);
				if (!Number.isSafeInteger(value)) throw new CborError("Decoded CBOR integer is outside the safe range");
				return value;
			}
			case 2: {
				const length = this.readLength(additionalInformation, "byte string", this.options.maxByteLength);
				return new Uint8Array(this.readBytes(length));
			}
			case 3: {
				const length = this.readLength(additionalInformation, "text string", this.options.maxByteLength);
				const bytes = this.readBytes(length);
				try {
					return textDecoder.decode(bytes);
				} catch (_error) {
					throw new CborError("CBOR text string contains invalid UTF-8");
				}
			}
			case 4: {
				const length = this.readLength(additionalInformation, "array", this.options.maxContainerLength);
				const result: unknown[] = [];
				for (let index = 0; index < length; index++) result.push(this.readItem(depth + 1));
				return result;
			}
			case 5: {
				const length = this.readLength(additionalInformation, "map", this.options.maxContainerLength);
				const result: Record<string, unknown> = {};
				const keys = new Set<string>();
				for (let index = 0; index < length; index++) {
					const key = this.readItem(depth + 1);
					if (typeof key !== "string") throw new CborError("CBOR map keys must be strings");
					if (keys.has(key)) throw new CborError("CBOR map contains a duplicate key");
					keys.add(key);
					Object.defineProperty(result, key, {
						configurable: true,
						enumerable: true,
						value: this.readItem(depth + 1),
						writable: true,
					});
				}
				return result;
			}
			case 6:
				throw new CborError("CBOR tags are not supported");
			case 7:
				return this.readSimple(additionalInformation);
			default:
				throw new CborError("Malformed CBOR major type");
		}
	}

	private readSimple(additionalInformation: number): unknown {
		switch (additionalInformation) {
			case 20:
				return false;
			case 21:
				return true;
			case 22:
				return null;
			case 27: {
				const bytes = this.readBytes(8);
				const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0, false);
				if (!Number.isFinite(value)) throw new CborError("Decoded CBOR number must be finite");
				if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
					throw new CborError("Decoded CBOR integer is outside the safe range");
				}
				return value;
			}
			case 31:
				throw new CborError("CBOR break marker is not supported");
			default:
				throw new CborError("Unsupported CBOR simple value or floating-point width");
		}
	}

	private readLength(additionalInformation: number, kind: string, limit: number): number {
		if (additionalInformation === 31) throw new CborError(`Indefinite-length CBOR ${kind}s are not supported`);
		const length = this.readArgument(additionalInformation);
		if (length > limit) throw new CborError(`CBOR ${kind} length exceeds configured limit of ${limit}`);
		return length;
	}

	private readArgument(additionalInformation: number): number {
		if (additionalInformation < 24) return additionalInformation;
		switch (additionalInformation) {
			case 24:
				return this.readByte();
			case 25: {
				const bytes = this.readBytes(2);
				return bytes[0]! * 0x100 + bytes[1]!;
			}
			case 26: {
				const bytes = this.readBytes(4);
				return bytes[0]! * 0x1_000_000 + bytes[1]! * 0x1_0000 + bytes[2]! * 0x100 + bytes[3]!;
			}
			case 27: {
				const high = this.readArgument(26);
				const low = this.readArgument(26);
				if (high > 0x1f_ffff) throw new CborError("Decoded CBOR integer or length is outside the safe range");
				return high * UINT32_BASE + low;
			}
			case 31:
				throw new CborError("Indefinite-length CBOR items are not supported");
			default:
				throw new CborError("Malformed CBOR additional information");
		}
	}

	private readByte(): number {
		if (this.offset >= this.bytes.byteLength) throw new CborError("Truncated CBOR payload");
		const value = this.bytes[this.offset]!;
		this.offset++;
		return value;
	}

	private readBytes(length: number): Uint8Array {
		if (length > this.bytes.byteLength - this.offset) throw new CborError("Truncated CBOR payload");
		const value = this.bytes.subarray(this.offset, this.offset + length);
		this.offset += length;
		return value;
	}
}

/** Decodes exactly one item from the protocol's strict RFC 8949 subset. */
export function decodeCbor(bytes: Uint8Array, options?: CborOptions): unknown {
	if (!(bytes instanceof Uint8Array)) throw new TypeError("CBOR input must be a Uint8Array");
	const resolved = resolveOptions(options);
	if (bytes.byteLength > resolved.maxByteLength) {
		throw new CborError(`CBOR byte length exceeds configured limit of ${resolved.maxByteLength}`);
	}
	return new CborReader(bytes, resolved).decode();
}
