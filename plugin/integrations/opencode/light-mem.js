// light-mem OpenCode plugin entry (shim).
// The full implementation lives in light-mem.bundle.mjs (non-.js
// extension so OpenCode does not auto-load it as a second plugin).
export { default, server } from "./light-mem.bundle.mjs";
