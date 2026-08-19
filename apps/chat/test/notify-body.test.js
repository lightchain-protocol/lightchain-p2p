import { describe, expect, it } from 'vitest'
import { announcement, bodyFor } from '../renderer/lib/notify-body.js'

const said = (text, attachment) => ({ text, ...(attachment ? { attachment } : {}) })

describe('what a desktop notification says', () => {
  it('is the message, when there is one', () => {
    expect(bodyFor(said('are you around?'))).toBe('are you around?')
  })

  // A file on its own is a message, so this is the ordinary case rather than a
  // malformed one — and taking the text as the body left it empty.
  it('names the file when a message is only an attachment', () => {
    expect(bodyFor(said('', { name: 'seaside.png' }))).toBe('Sent seaside.png')
  })

  it('says something even when the file has no usable name', () => {
    expect(bodyFor(said('', { name: '' }))).toBe('Sent an attachment')
  })

  // A message with neither is a control event from a version newer than this
  // one, whose kind `parseEvent` dropped. Claiming a file would be inventing
  // one; callers filter these out before they reach a notification at all.
  it('does not claim a file when there is no attachment either', () => {
    expect(bodyFor(said(''))).toBe('New activity')
    expect(bodyFor({})).toBe('New activity')
  })

  it('prefers the caption over the filename when both are there', () => {
    expect(bodyFor(said('look at this', { name: 'seaside.png' }))).toBe('look at this')
  })

  it('treats whitespace as no caption at all', () => {
    expect(bodyFor(said('   \n  ', { name: 'seaside.png' }))).toBe('Sent seaside.png')
  })

  // This string is handed to the operating system, which will not scrub it, and
  // is read in a corner of a screen by somebody not looking for a trick.
  it('strips the direction marks out of a filename', () => {
    const spoofed = `holiday${String.fromCharCode(0x202e)}gnp.exe`
    const body = bodyFor(said('', { name: spoofed }))

    expect(body).toBe('Sent holidaygnp.exe')
    expect([...body].some((ch) => ch.codePointAt(0) === 0x202e)).toBe(false)
  })

  it('strips them out of message text too, which is equally somebody else’s', () => {
    const body = bodyFor(said(`meet me${String.fromCharCode(0x202e)}erehwemos`))
    expect([...body].some((ch) => ch.codePointAt(0) === 0x202e)).toBe(false)
  })

  it('strips control characters, which can forge a second line', () => {
    expect(bodyFor(said('one\u0000two\u001ftbree'))).toBe('onetwotbree')
  })
})

describe('announcing several at once', () => {
  it('is just the message when only one arrived', () => {
    expect(announcement([said('hello')])).toBe('hello')
  })

  it('counts them and quotes the last', () => {
    expect(announcement([said('one'), said('two'), said('three')])).toBe(
      '3 new messages. Latest: three'
    )
  })

  // The case that produced a body ending in a colon and nothing else.
  it('does not trail off when the last of several is an attachment', () => {
    const body = announcement([said('one'), said('', { name: 'seaside.png' })])

    expect(body).toBe('2 new messages. Latest: Sent seaside.png')
    expect(body.trimEnd().endsWith(':')).toBe(false)
  })
})
