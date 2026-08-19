import { el2, toast } from './dom.js'
import { bridge } from './ipc.js'

/**
 * Message text, turned into nodes.
 *
 * Built from text nodes and elements, never from a markup string. The content
 * is written by other people, and the moment any of it reaches `innerHTML` a
 * room member can run script in everybody else's window. That constraint is
 * why this is a small recursive matcher rather than a markdown library: every
 * one of those produces HTML, and the safe ones are larger than this file.
 */

/**
 * Matches a bare http or https URL up to the first character that cannot be in
 * one. Trailing punctuation is excluded so "see https://x.com." does not
 * produce a link with a full stop on the end.
 */
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]/g

/**
 * The inline marks, in the order they are looked for.
 *
 * Code first and deliberately: inside backticks nothing else applies, so
 * `**not bold**` in a code span stays literal. Anything matched here is
 * consumed whole, which is what stops a later rule reaching into it.
 */
const MARKS = [
  { pattern: /`([^`\n]+)`/, tag: 'code', className: 'md-code' },
  { pattern: /\*\*([^*\n]+)\*\*/, tag: 'strong', className: null },
  { pattern: /(?<![\w*])\*([^*\n]+)\*(?![\w*])/, tag: 'em', className: null },
  { pattern: /~~([^~\n]+)~~/, tag: 's', className: null }
]

/**
 * Shortcodes worth typing. Deliberately a short list rather than a full emoji
 * set: a thousand names nobody remembers is a dictionary, not a feature.
 */
const EMOJI = {
  ':)': '🙂',
  ':(': '🙁',
  ':D': '😀',
  ';)': '😉',
  ':smile:': '😄',
  ':grin:': '😁',
  ':wink:': '😉',
  ':thumbsup:': '👍',
  ':thumbsdown:': '👎',
  ':heart:': '❤️',
  ':fire:': '🔥',
  ':tada:': '🎉',
  ':eyes:': '👀',
  ':thinking:': '🤔',
  ':check:': '✅',
  ':x:': '❌',
  ':warning:': '⚠️',
  ':rocket:': '🚀',
  ':100:': '💯',
  ':pray:': '🙏',
  ':clap:': '👏',
  ':lock:': '🔒'
}

const EMOJI_PATTERN = new RegExp(
  Object.keys(EMOJI)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'g'
)

/** Puts message text into a node, with links, marks and emoji. */
export function renderText(into, text) {
  into.replaceChildren()
  into.append(...inline(text))
}

/** The pieces of one run of text, as nodes. */
function inline(text) {
  if (text === '') return []

  // Links win over marks, because a URL is full of characters the marks use
  // and an underscore in a query string is not emphasis.
  URL_PATTERN.lastIndex = 0
  const url = URL_PATTERN.exec(text)
  if (url) {
    // Both offsets are taken before recursing. The pattern is global, so its
    // `lastIndex` is shared state the recursive call overwrites — reading it
    // afterwards gave the wrong tail, and when it came back zero the slice was
    // the whole string again and this recursed until the renderer hung.
    const start = url.index
    const end = start + url[0].length
    return [...inline(text.slice(0, start)), link(url[0]), ...inline(text.slice(end))]
  }

  for (const mark of MARKS) {
    const match = mark.pattern.exec(text)
    if (!match) continue

    const node = document.createElement(mark.tag)
    if (mark.className) node.className = mark.className
    // Code is literal all the way down; everything else can nest.
    if (mark.tag === 'code') node.append(...emoji(match[1]))
    else node.append(...inline(match[1]))

    return [
      ...inline(text.slice(0, match.index)),
      node,
      ...inline(text.slice(match.index + match[0].length))
    ]
  }

  return emoji(text)
}

/** Text with shortcodes swapped for the characters they name. */
function emoji(text) {
  EMOJI_PATTERN.lastIndex = 0
  return [text.replace(EMOJI_PATTERN, (found) => EMOJI[found])]
}

/**
 * A link that opens in the browser rather than in here.
 *
 * An anchor with an href would navigate the application window, replacing the
 * app with whatever a stranger linked. This is a span that asks the main
 * process to open it, and the main process refuses anything that is not http or
 * https — `shell.openExternal` will otherwise hand the system a `file://` URL
 * or a shortcut, which is a way to run a program on this machine.
 */
function link(href) {
  const node = el2('span', 'link', href)
  node.setAttribute('role', 'link')
  node.setAttribute('tabindex', '0')
  node.title = `Open ${href} in your browser`

  const open = () => {
    void bridge.openExternal(href).then((ok) => {
      if (!ok) toast('That link could not be opened', 'error')
    })
  }
  node.addEventListener('click', open)
  node.addEventListener('keydown', (evt) => {
    if (evt.key === 'Enter' || evt.key === ' ') {
      evt.preventDefault()
      open()
    }
  })
  return node
}
