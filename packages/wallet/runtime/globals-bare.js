// @noble reaches for both of these while its own module body is evaluating, so
// importing the hash or the curve fails before any of our code runs. Bare
// provides neither as a global.
import 'bare-encoding/global'
import 'bare-crypto/global'
