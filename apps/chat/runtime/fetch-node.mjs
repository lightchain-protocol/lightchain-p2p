// Node, and the vitest run that checks these handlers without an Electron
// window. `bare-fetch` reaches a native addon that will not load here, so the
// split exists to keep the worker handlers testable off Bare at all.
export default globalThis.fetch
