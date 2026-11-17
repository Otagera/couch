import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMediaPath } from "../src/server/media/parse.ts";

const cases: [string, ReturnType<typeof parseMediaPath>][] = [
	[
		"Movies/Heat (1995)/Heat (1995).mkv",
		{ kind: "movie", title: "Heat", year: 1995 },
	],
	["Heat (1995).mp4", { kind: "movie", title: "Heat", year: 1995 }],
	[
		"Movies/Heat.1995.1080p.BluRay.x264-GROUP.mkv",
		{ kind: "movie", title: "Heat", year: 1995 },
	],
	[
		"Blade.Runner.2049.2017.2160p.UHD.mkv",
		{ kind: "movie", title: "Blade Runner 2049", year: 2017 },
	],
	["1917 (2019)/1917 (2019).mkv", { kind: "movie", title: "1917", year: 2019 }],
	[
		"Some Film.1080p.WEB-DL.mkv",
		{ kind: "movie", title: "Some Film", year: null },
	],
	[
		"TV/Succession/Season 04/S04E09.mkv",
		{
			kind: "episode",
			show: "Succession",
			year: null,
			season: 4,
			episode: 9,
			episodeEnd: 9,
		},
	],
	[
		"Succession (2018)/Season 4/Succession - S04E09 - Church and State.mkv",
		{
			kind: "episode",
			show: "Succession",
			year: 2018,
			season: 4,
			episode: 9,
			episodeEnd: 9,
		},
	],
	[
		"Downloads/Succession.S04E09E10.1080p.WEB.H264.mkv",
		{
			kind: "episode",
			show: "Succession",
			year: null,
			season: 4,
			episode: 9,
			episodeEnd: 10,
		},
	],
	[
		"The Office (US)/1x05.avi",
		{
			kind: "episode",
			show: "The Office (US)",
			year: null,
			season: 1,
			episode: 5,
			episodeEnd: 5,
		},
	],
	[
		"Shows/Abbott Elementary/S05/Abbott.Elementary.s05e22.mkv",
		{
			kind: "episode",
			show: "Abbott Elementary",
			year: null,
			season: 5,
			episode: 22,
			episodeEnd: 22,
		},
	],
	["Movies/Heat (1995)/Extras/Making of.mkv", null],
	["Movies/Heat (1995)/heat-sample.mkv", null],
	["Movies/Heat (1995)/Heat (1995).srt", null],
	["notes.txt", null],
];

for (const [path, expected] of cases) {
	test(`parse: ${path}`, () => {
		assert.deepEqual(parseMediaPath(path), expected);
	});
}
