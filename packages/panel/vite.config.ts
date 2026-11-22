import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import solid from "vite-plugin-solid";

// The server authenticates every request, and a <script src> cannot send the token header, so the
// whole panel is inlined into one index.html instead of being served as separate assets.
export default defineConfig({
  plugins: [solid(), viteSingleFile()],
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
});
