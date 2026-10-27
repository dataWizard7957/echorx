// EchoRx's H-MEM engine entry point. The conformance suite loads this file
// (npm run test:hmem). The engine is the Meterless H-MEM reference
// implementation (Apache-2.0, see NOTICE) with file-backed persistence enabled
// by EchoRx via the `persistDir` option; EchoRx's clinical use lives in
// careMemory.ts.
export * from "./engine/index.ts";
