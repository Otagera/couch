import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { exportFiles } from "../src/server/letterboxdUpload.ts";
import { readZip } from "../src/server/zip.ts";

/** Tiny zip writer for tests: stored or deflated entries, no data descriptors. */
function makeZip(
	files: { name: string; data: string; deflate?: boolean }[],
): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const f of files) {
		const raw = Buffer.from(f.data);
		const body = f.deflate ? deflateRawSync(raw) : raw;
		const name = Buffer.from(f.name);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(f.deflate ? 8 : 0, 8);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(name.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(0x800, 8);
		central.writeUInt16LE(f.deflate ? 8 : 0, 10);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(raw.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		locals.push(local, name, body);
		centrals.push(central, name);
		offset += 30 + name.length + body.length;
	}
	const cd = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(files.length, 8);
	eocd.writeUInt16LE(files.length, 10);
	eocd.writeUInt32LE(cd.length, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, cd, eocd]);
}

test("readZip reads stored and deflated entries", () => {
	const zip = makeZip([
		{ name: "watched.csv", data: "Date,Name\n2024-01-01,Heat\n" },
		{ name: "likes/films.csv", data: "x".repeat(5000), deflate: true },
	]);
	const entries = readZip(zip);
	assert.deepEqual(
		entries.map((e) => [e.name, e.data.length]),
		[
			["watched.csv", 26],
			["likes/films.csv", 5000],
		],
	);
	assert.throws(
		() => readZip(Buffer.from("not a zip at all, definitely not")),
		/Not a zip/,
	);
});

test("exportFiles keeps only known export files and blocks path tricks", () => {
	const files = exportFiles(
		readZip(
			makeZip([
				{ name: "watched.csv", data: "a" },
				{ name: "Ratings.csv", data: "b" },
				{ name: "lists/mcu-chronological.csv", data: "c" },
				{ name: "likes/lists.csv", data: "d" },
				{ name: "deleted/diary.csv", data: "skip" },
				{ name: "../../etc/passwd.csv", data: "evil" },
				{ name: "lists/../../evil.csv", data: "evil" },
				{ name: "notes.txt", data: "skip" },
			]),
		),
	);
	assert.deepEqual([...files.keys()].sort(), [
		"likes/lists.csv",
		"lists/mcu-chronological.csv",
		"ratings.csv",
		"watched.csv",
	]);
});

test("exportFiles strips a single top-level folder", () => {
	const files = exportFiles(
		readZip(
			makeZip([
				{ name: "letterboxd-user-2026-11-17/watched.csv", data: "a" },
				{ name: "letterboxd-user-2026-11-17/likes/films.csv", data: "b" },
			]),
		),
	);
	assert.deepEqual([...files.keys()].sort(), [
		"likes/films.csv",
		"watched.csv",
	]);
});
