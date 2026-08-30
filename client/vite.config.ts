import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	// Configuration is one `.env` at the repository root, shared with the server and Docker
	// Compose (see AGENTS.md). Without this, Vite would look in `client/` and quietly find
	// nothing. Only `VITE_`-prefixed variables are exposed to the bundle, as always.
	envDir: "..",

	plugins: [
		// Please make sure that '@tanstack/router-plugin' is passed before '@vitejs/plugin-react'
		tanstackRouter({
			target: "react",
			autoCodeSplitting: true,
		}),
		react(),
		tailwindcss(),
	],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
});
