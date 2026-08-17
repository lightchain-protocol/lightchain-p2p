// Bare does not install the WHATWG text encoding interfaces as globals, and
// @noble/curves reaches for TextEncoder while its module body is still
// evaluating — so importing the curve at all fails before any of our code runs.
//
// Installing a global from a library is impolite, but the alternative is every
// consumer remembering to do it, and forgetting produces a ReferenceError from
// inside a dependency rather than anything that points here.
import 'bare-encoding/global'

// Same reason: noble reaches for globalThis.crypto.getRandomValues when it
// generates a key. bare-crypto's is a real CSPRNG, not a shim.
import 'bare-crypto/global'
