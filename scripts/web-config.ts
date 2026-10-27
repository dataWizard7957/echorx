// esbuild options shared by `npm run build` and `npm run dev`.
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const WEB = path.join(ROOT, "web");
export const DIST = path.join(WEB, "dist");

export const buildOptions: esbuild.BuildOptions = {
  entryPoints: [path.join(WEB, "src", "main.tsx")],
  bundle: true,
  outfile: path.join(DIST, "assets", "app.js"),
  format: "esm",
  jsx: "automatic",
  target: "es2020",
  sourcemap: true,
  minify: process.argv.includes("--minify") || !process.argv.includes("--watch"),
  define: { "process.env.NODE_ENV": JSON.stringify(process.argv.includes("--watch") ? "development" : "production") },
  logLevel: "info",
};

export function copyStatic(): void {
  fs.mkdirSync(DIST, { recursive: true });
  fs.copyFileSync(path.join(WEB, "index.html"), path.join(DIST, "index.html"));
  fs.cpSync(path.join(WEB, "public"), DIST, { recursive: true });
  fs.copyFileSync(path.join(WEB, "src", "styles.css"), path.join(DIST, "assets", "styles.css"));
}

