/**
 * Minimal zip reader for the Letterboxd export: enough to list entries and
 * inflate stored or deflated files, using node:zlib (no dependencies).
 *
 * Reads the central directory (authoritative) rather than scanning local
 * headers, so sizes are known even when entries use data descriptors.
 * No zip64, encryption or multi-disk support; a Letterboxd export needs none.
 */

import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
	name: string;
	data: Buffer;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export function readZip(
	buf: Buffer,
	opts: { maxEntryBytes?: number } = {},
): ZipEntry[] {
	const maxEntry = opts.maxEntryBytes ?? 50 * 1024 * 1024;
	// The end-of-central-directory record sits in the last 22 + 65535 bytes.
	let eocd = -1;
	for (
		let i = buf.length - 22;
		i >= Math.max(0, buf.length - 22 - 65535);
		i--
	) {
		if (buf.readUInt32LE(i) === EOCD_SIG) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error("Not a zip file.");
	const count = buf.readUInt16LE(eocd + 10);
	let p = buf.readUInt32LE(eocd + 16);

	const entries: ZipEntry[] = [];
	for (let n = 0; n < count; n++) {
		if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG)
			throw new Error("Corrupt zip directory.");
		const flags = buf.readUInt16LE(p + 8);
		const method = buf.readUInt16LE(p + 10);
		const compSize = buf.readUInt32LE(p + 20);
		const size = buf.readUInt32LE(p + 24);
		const nameLen = buf.readUInt16LE(p + 28);
		const extraLen = buf.readUInt16LE(p + 30);
		const commentLen = buf.readUInt16LE(p + 32);
		const localOffset = buf.readUInt32LE(p + 42);
		const name = buf.toString(
			flags & 0x800 ? "utf8" : "latin1",
			p + 46,
			p + 46 + nameLen,
		);
		p += 46 + nameLen + extraLen + commentLen;

		if (name.endsWith("/")) continue; // directory
		if (flags & 0x1) throw new Error("Encrypted zips aren't supported.");
		if (size > maxEntry) throw new Error(`${name} is too large.`);
		if (
			localOffset + 30 > buf.length ||
			buf.readUInt32LE(localOffset) !== LOCAL_SIG
		) {
			throw new Error("Corrupt zip entry.");
		}
		const start =
			localOffset +
			30 +
			buf.readUInt16LE(localOffset + 26) +
			buf.readUInt16LE(localOffset + 28);
		const raw = buf.subarray(start, start + compSize);
		let data: Buffer;
		if (method === 0) data = Buffer.from(raw);
		else if (method === 8)
			data = inflateRawSync(raw, { maxOutputLength: maxEntry });
		else throw new Error(`${name} uses an unsupported compression method.`);
		entries.push({ name, data });
	}
	return entries;
}
