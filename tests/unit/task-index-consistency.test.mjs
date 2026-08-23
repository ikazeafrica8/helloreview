// Unit tier: the task index must agree with the task sections beneath it.
//
// WHY THIS EXISTS. tasks/todo.md records the same fact twice: a one-line entry in the Task Index at
// the top, and a block of acceptance criteria further down. I kept the two in step for T1–T13 and
// then stopped — every criterion for T14 through T23 was ticked off as it landed while the index
// still showed all ten as not started. Nothing failed, nothing warned; the only symptom was that
// the file's own summary said Phase 2 had not begun.
//
// That is the same defect class both audits kept finding — a record asserting something the
// underlying work does not support — applied to the plan rather than to the code. A plan nobody can
// trust at a glance is a plan people stop reading, and it is the first thing anyone opens.
//
// So the agreement is checked rather than remembered. This is a pure text check: no database, no
// build, no network.

import { test, describe, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

const ROOT = dirname(dirname(import.meta.dirname))
const TODO = readFileSync(join(ROOT, 'tasks', 'todo.md'), 'utf8')

/** `- [x] T14 — ...` / `- [ ] T14 — ...` from the index at the top of the file. */
const indexEntries = () => {
  const found = new Map()
  for (const line of TODO.split('\n')) {
    const match = /^- \[( |x)\] T(\d+) — /.exec(line)
    if (match !== null) found.set(Number(match[2]), match[1] === 'x')
  }
  return found
}

/**
 * Every task's acceptance criteria, keyed by task number.
 *
 * A section runs from its `## T<n> — ` heading to the next heading. Only the checkboxes under
 * **Acceptance criteria** count — the Verification block is a separate list, and a task can
 * legitimately have its criteria met while a manual verification note is still being written.
 */
const acceptanceCriteria = () => {
  const sections = TODO.split(/^## T(\d+) — /m)
  const found = new Map()

  for (let index = 1; index < sections.length; index += 2) {
    const number = Number(sections[index])
    const body = sections[index + 1] ?? ''
    const criteriaBlock = /\*\*Acceptance criteria:\*\*([\s\S]*?)(?:\*\*Verification|\*\*Dependencies|$)/.exec(body)
    if (criteriaBlock === null) continue

    const boxes = [...criteriaBlock[1].matchAll(/^- \[( |x)\] /gm)].map((match) => match[1] === 'x')
    if (boxes.length > 0) found.set(number, boxes)
  }
  return found
}

describe('the task index agrees with the task sections', () => {
  test('the file is actually parseable, so the checks below are not vacuous', () => {
    // Guards the two parsers. If a future edit changes the heading or checkbox format, every
    // assertion here would silently pass against an empty map.
    expect(indexEntries().size, 'no index entries were parsed').toBeGreaterThan(20)
    expect(acceptanceCriteria().size, 'no acceptance-criteria blocks were parsed').toBeGreaterThan(20)
  })

  test('a task whose criteria are ALL met is marked done in the index', () => {
    const index = indexEntries()
    const criteria = acceptanceCriteria()
    const inconsistent = []

    for (const [number, boxes] of criteria) {
      const allMet = boxes.every(Boolean)
      const markedDone = index.get(number)
      if (markedDone === undefined) continue
      if (allMet && !markedDone) {
        inconsistent.push(`T${String(number)}: every acceptance criterion is met but the index says not started`)
      }
    }

    expect(
      inconsistent,
      'The Task Index and the task sections disagree. The index is what anyone reads first, so a ' +
        'stale one misrepresents the state of the whole plan.\n\n' +
        inconsistent.map((entry) => `    - ${entry}`).join('\n'),
    ).toEqual([])
  })

  test('a task marked done in the index has no unmet criteria', () => {
    // The more important direction. The other way round is untidy; this way round is a false claim
    // of completion, which is what makes a plan actively misleading rather than merely behind.
    const index = indexEntries()
    const criteria = acceptanceCriteria()
    const overclaimed = []

    for (const [number, markedDone] of index) {
      const boxes = criteria.get(number)
      if (!markedDone || boxes === undefined) continue
      const unmet = boxes.filter((met) => !met).length
      if (unmet > 0) {
        overclaimed.push(`T${String(number)}: marked done with ${String(unmet)} unmet acceptance criterion(a)`)
      }
    }

    expect(
      overclaimed,
      'A task is marked complete while its own acceptance criteria say otherwise.\n\n' +
        overclaimed.map((entry) => `    - ${entry}`).join('\n'),
    ).toEqual([])
  })

  test('every task in the index has a section, and every section an index entry', () => {
    // A task that exists in only one place is how the two drift apart in the first place.
    const index = indexEntries()
    const criteria = acceptanceCriteria()
    const missing = []

    for (const number of index.keys()) {
      if (!criteria.has(number)) missing.push(`T${String(number)} is in the index with no acceptance criteria`)
    }
    for (const number of criteria.keys()) {
      if (!index.has(number)) missing.push(`T${String(number)} has a section but no index entry`)
    }

    expect(missing, missing.join('\n')).toEqual([])
  })
})
