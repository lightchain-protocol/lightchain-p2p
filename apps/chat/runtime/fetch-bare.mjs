// Bare has no global fetch, and reaching for one throws a ReferenceError that a
// try/catch turns into "the service is unreachable" — a lie that already cost an
// afternoon once, on the Ollama probe.
export { default } from 'bare-fetch'
