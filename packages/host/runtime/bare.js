// Bare has no global fetch. Reaching for one throws a ReferenceError, and in a
// probe wrapped in try/catch that surfaces as "the service is not reachable" —
// so the Ollama check reported a false failure on every Bare host, telling
// operators to start something already running.
export { default } from 'bare-fetch'
