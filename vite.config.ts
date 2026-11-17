import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
	resolve: { tsconfigPaths: true },
	plugins: [
		nitro({
			// Loaded from node_modules at runtime, not bundled: its X.509
			// dependency needs reflect-metadata to load first, and bundling into
			// shared chunks breaks that order.
			traceDeps: ["@simplewebauthn/server", "reflect-metadata"],
			plugins: [
				fileURLToPath(new URL("./src/server/scheduler.ts", import.meta.url)),
			],
			handlers: [
				// Middleware runs ahead of every route, pages and server functions
				// alike, so auth cannot be bypassed.
				{
					middleware: true,
					route: "/**",
					handler: fileURLToPath(
						new URL("./src/server/authHandler.ts", import.meta.url),
					),
				},
				{
					route: "/api/letterboxd/upload",
					handler: fileURLToPath(
						new URL("./src/server/letterboxdUpload.ts", import.meta.url),
					),
				},
				{
					route: "/api/media/import",
					handler: fileURLToPath(
						new URL("./src/server/media/importHandler.ts", import.meta.url),
					),
				},
				{
					route: "/auth/**",
					handler: fileURLToPath(
						new URL("./src/server/auth/handlers.ts", import.meta.url),
					),
				},
			],
		}),
		tailwindcss(),
		tanstackStart(),
		viteReact(),
	],
});
