import { describe, expect, it } from 'vitest'
import { deriveChildSK, deriveFromPath, deriveMasterSK, publicKeyOf, sign, verify } from './keys.js'
import { fromHex } from './deposit.js'

/**
 * The EIP-2333 test vectors, from the specification itself.
 *
 * These are the whole reason this derivation is written out rather than
 * approximated. Every mistake available here — the wrong salt, the missing
 * trailing zero byte on the IKM, the length appended to the wrong argument,
 * big-endian where the specification says little — produces a key that is
 * perfectly valid and simply is not the one the phrase means. There is no
 * symptom until a validator that was supposed to be recoverable is not.
 *
 * https://eips.ethereum.org/EIPS/eip-2333#test-cases
 */
const VECTORS = [
  {
    name: 'test case 0',
    seed: '0xc55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04',
    masterSK: 6083874454709270928345386274498605044986640685124978867557563392430687146096n,
    childIndex: 0,
    childSK: 20397789859736650942317412262472558107875392172444076792671091975210932703118n
  },
  {
    name: 'test case 1',
    seed: '0x3141592653589793238462643383279502884197169399375105820974944592',
    masterSK: 29757020647961307431480504535336562678282505419141012933316116377660817309383n,
    childIndex: 3141592653,
    childSK: 25457201688850691947727629385191704516744796114925897962676248250929345014287n
  },
  {
    name: 'test case 2',
    seed: '0x0099FF991111002299DD7744EE3355BBDD8844115566CC55663355668888CC00',
    masterSK: 27580842291869792442942448775674722299803720648445448686099262467207037398656n,
    childIndex: 4294967295,
    childSK: 29358610794459428860402234341874281240803786294062035874021252734817515685787n
  },
  {
    name: 'test case 3',
    seed: '0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3',
    masterSK: 19022158461524446591288038168518313374041767046816487870552872741050760015818n,
    childIndex: 42,
    childSK: 31372231650479070279774297061823572166496564838472787488249775572789064611981n
  }
]

describe('EIP-2333 key derivation', () => {
  it('matches the specification for every published vector', () => {
    for (const vector of VECTORS) {
      const seed = fromHex(vector.seed)
      expect(deriveMasterSK(seed), `${vector.name} master`).toBe(vector.masterSK)
      expect(deriveChildSK(vector.masterSK, vector.childIndex), `${vector.name} child`).toBe(
        vector.childSK
      )
    }
  })

  it('refuses a seed shorter than the specification allows', () => {
    expect(() => deriveMasterSK(new Uint8Array(31))).toThrow(/at least 32 bytes/)
  })

  it('refuses an index outside a uint32', () => {
    expect(() => deriveChildSK(1n, -1)).toThrow(/uint32/)
    expect(() => deriveChildSK(1n, 2 ** 32)).toThrow(/uint32/)
  })
})

/** The first published vector, named so the compiler can see it exists. */
const FIRST_SEED =
  '0xc55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04'

describe('EIP-2334 paths', () => {
  const seed = fromHex(FIRST_SEED)

  it('walks a path as repeated child derivation', () => {
    const master = deriveMasterSK(seed)
    expect(deriveFromPath(seed, 'm')).toBe(master)
    expect(deriveFromPath(seed, 'm/0')).toBe(deriveChildSK(master, 0))
    expect(deriveFromPath(seed, 'm/12381/3600/0/0/0')).toBe(
      deriveChildSK(
        deriveChildSK(deriveChildSK(deriveChildSK(deriveChildSK(master, 12381), 3600), 0), 0),
        0
      )
    )
  })

  it('refuses anything that is not a path of indices', () => {
    expect(() => deriveFromPath(seed, '12381/3600')).toThrow(/starts with "m"/)
    expect(() => deriveFromPath(seed, "m/12381'/3600")).toThrow(/is not an index/)
  })
})

describe('the signature scheme', () => {
  it('is the one the beacon chain uses: 48-byte keys, 96-byte signatures', () => {
    const sk = deriveFromPath(fromHex(FIRST_SEED), 'm/12381/3600/0/0/0')
    const pk = publicKeyOf(sk)
    expect(pk.length).toBe(48)

    const message = new Uint8Array(32).fill(7)
    const signature = sign(sk, message)
    expect(signature.length).toBe(96)
    expect(verify(signature, message, pk)).toBe(true)
  })

  it('does not verify a signature over a different message', () => {
    const sk = deriveFromPath(fromHex(FIRST_SEED), 'm/12381/3600/0/0/0')
    const signature = sign(sk, new Uint8Array(32).fill(7))
    expect(verify(signature, new Uint8Array(32).fill(8), publicKeyOf(sk))).toBe(false)
  })
})
