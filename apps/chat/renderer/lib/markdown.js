import { copy } from './dom.js'
import { inline } from './format.js'

/**
 * A model's answer, turned into nodes.
 *
 * Models write markdown whether or not anybody asked them to: a fenced block
 * for code, a list for steps, a heading over each part. Shown as plain text
 * that is a page of asterisks and backticks. This reads the block structure -
 * fences, headings, lists, paragraphs - and hands each run of text to the same
 * inline matcher a room message uses.
 *
 * Built from elements and text nodes, never from a markup string, for the
 * reason `format.js` gives: the text was written by something else, and the
 * moment any of it reaches `innerHTML` it can run script in this window.
 *
 * It is called again on every token while an answer streams, so it has to be
 * right about text that stops anywhere: a fence that has opened and not yet
 * closed is a code block that runs to the end.
 */

const FENCE = /^\s*```\s*([\w+#.-]*)\s*$/
const HEADING = /^(#{1,4})\s+(.+?)\s*#*\s*$/
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/
const BULLET = /^\s*[-*•]\s+(.*)$/
const NUMBERED = /^\s*(\d{1,3})[.)]\s+(.*)$/

/** Puts an answer into `into`, replacing whatever was there. */
export function renderAnswer(into, text) {
  into.replaceChildren(...blocks(String(text ?? '')))
}

function blocks(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let paragraph = []
  let list = null

  const endParagraph = () => {
    if (paragraph.length === 0) return
    const node = document.createElement('p')
    node.className = 'md-p'
    node.append(...inline(paragraph.join('\n')))
    out.push(node)
    paragraph = []
  }

  const endList = () => {
    if (list !== null) out.push(list)
    list = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const fence = FENCE.exec(line)
    if (fence) {
      endParagraph()
      endList()
      const body = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++])
      out.push(codeBlock(body.join('\n'), fence[1]))
      continue
    }

    if (line.trim() === '') {
      endParagraph()
      endList()
      continue
    }

    // Before lists: `- - -` is a divider, not three empty bullets.
    if (RULE.test(line)) {
      endParagraph()
      endList()
      const rule = document.createElement('hr')
      rule.className = 'md-rule'
      out.push(rule)
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      endParagraph()
      endList()
      const node = document.createElement('p')
      node.className = 'md-heading'
      node.setAttribute('role', 'heading')
      node.setAttribute('aria-level', String(heading[1].length + 2))
      node.append(...inline(heading[2]))
      out.push(node)
      continue
    }

    const bullet = BULLET.exec(line)
    const numbered = bullet ? null : NUMBERED.exec(line)
    if (bullet || numbered) {
      endParagraph()
      const tag = bullet ? 'ul' : 'ol'
      if (list === null || list.localName !== tag) {
        endList()
        list = document.createElement(tag)
        list.className = 'md-list'
        // A list that starts at 3 was written that way: the steps before it
        // are usually in an earlier part of the same answer.
        if (numbered && numbered[1] !== '1') list.setAttribute('start', numbered[1])
      }
      const item = document.createElement('li')
      item.append(...inline(bullet ? bullet[1] : numbered[2]))
      list.append(item)
      continue
    }

    // An indented line under a list item continues that item rather than
    // ending the list and starting a paragraph beneath it.
    if (list !== null && /^\s{2,}\S/.test(line) && list.lastElementChild) {
      list.lastElementChild.append('\n', ...inline(line.trim()))
      continue
    }

    endList()
    paragraph.push(line)
  }

  endParagraph()
  endList()
  return out
}

/** A fenced block: the code as written, and a way to take it away. */
function codeBlock(code, language) {
  const block = document.createElement('div')
  block.className = 'md-block'

  const head = document.createElement('div')
  head.className = 'md-block-head'

  const name = document.createElement('span')
  name.className = 'md-block-lang'
  name.textContent = language || 'code'

  const take = document.createElement('button')
  take.type = 'button'
  take.className = 'button button-sm md-block-copy'
  take.textContent = 'Copy'
  take.addEventListener('click', () => void copy(code, 'Code'))

  head.append(name, take)

  const pre = document.createElement('pre')
  pre.className = 'md-block-code'
  const inner = document.createElement('code')
  inner.textContent = code
  pre.append(inner)

  block.append(head, pre)
  return block
}
