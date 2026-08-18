import { runChecks, summarize } from '@lcai-p2p/preflight'
import { probeAll } from '@lcai-p2p/host'

const MARK = { pass: '  ok  ', warn: ' warn ', fail: ' FAIL ' }

/**
 * Reports whether this host can run a worker, and what to do if it cannot.
 *
 * The existing toolkit documents sixteen failure modes and detects none of them,
 * so an operator meets them as opaque errors several phases into onboarding —
 * or worse, after a job has been accepted and lost. Everything checkable is
 * checked here, before anything is installed.
 */
export async function doctor({ ollamaPort, diskPath } = {}) {
  const probes = await probeAll({ ollamaPort, diskPath })
  const results = runChecks(probes)
  const totals = summarize(results)

  console.log('')
  for (const r of results) {
    console.log(`[${MARK[r.status]}] ${r.title}: ${r.detail}`)
    if (r.remedy) {
      for (const line of wrap(r.remedy, 74)) console.log(`           ${line}`)
    }
  }

  console.log('')
  console.log(`${totals.passed} passed, ${totals.warned} warnings, ${totals.failed} failed`)

  if (totals.ready) {
    console.log('This host can run a worker.')
  } else {
    console.log(
      'This host cannot run a worker yet. Resolve the failures above and run doctor again.'
    )
  }

  return totals.ready
}

function wrap(text, width) {
  const words = text.split(' ')
  const lines = []
  let line = ''
  for (const word of words) {
    if (line.length + word.length + 1 > width) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(line)
  return lines
}
