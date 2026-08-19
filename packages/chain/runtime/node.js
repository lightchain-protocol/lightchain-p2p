// Node and browsers have had fetch as a global since Node 18.
//
// Called through rather than captured. `export default globalThis.fetch` binds
// whatever exists the moment this module is first imported, which means a fetch
// installed afterwards — a test double, a proxy agent, a polyfill — is ignored
// by everything in this package, silently and for the rest of the process.
export default function fetch(...args) {
  return globalThis.fetch(...args)
}
