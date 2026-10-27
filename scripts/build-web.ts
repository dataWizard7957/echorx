// Bundles the React app with esbuild into web/dist (no Vite needed).
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { DIST, ROOT, buildOptions, copyStatic } from "./web-config.ts";

fs.rmSync(DIST, { recursive: true, force: true });
await esbuild.build(buildOptions);
copyStatic();
console.log(`web built → ${path.relative(ROOT, DIST)}`);
