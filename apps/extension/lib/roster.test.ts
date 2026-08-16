import assert from 'node:assert/strict'
import {
  assignableOn, assigneeOptionsHtml, keepAssignee,
  ASSIGNEE_NOBODY_LABEL, ASSIGNEE_NONE_ON_BOARD_LABEL, ASSIGNEE_UNAVAILABLE_LABEL, ROLE_UNDESCRIBED,
  type ProjectsAnswer,
} from './roster'

// The shape GET /api/projects answers with: a roster dictionary plus, per board, the handles assignable there.
// `nomad` is registered on no board, which is why the server offers it on BOTH.
const ANSWER: ProjectsAnswer = {
  ok: true,
  defaultId: 'p1',
  agents: [
    { handle: 'huester', title: 'Агент tester-huester', role: 'Делает доску и расширение.' },
    { handle: 'erental', title: 'Агент eRENTAL', role: 'Ведёт прокатный проект.' },
    { handle: 'nomad', title: '', role: '' },
  ],
  projects: [
    { id: 'p1', name: 'tester-huester', assignable: ['huester', 'nomad'] },
    { id: 'p2', name: 'erental', assignable: ['erental', 'nomad'] },
    { id: 'p3', name: 'пустая доска', assignable: [] },
  ],
}

// 1. Handles resolve through the dictionary, in the order the server put them — board regulars first, the
//    boardless agent last.
{
  assert.deepEqual(assignableOn(ANSWER, 'p1').map((a) => a.handle), ['huester', 'nomad'])
  assert.deepEqual(assignableOn(ANSWER, 'p2').map((a) => a.handle), ['erental', 'nomad'])
  assert.equal(assignableOn(ANSWER, 'p1')[0]!.title, 'Агент tester-huester', 'the profile travels with the handle')
}

// 2. Nobody to offer: an empty board, an unknown board, and an answer that never arrived are all "no options"
//    — the labels below are what tells them apart.
{
  assert.deepEqual(assignableOn(ANSWER, 'p3'), [])
  assert.deepEqual(assignableOn(ANSWER, 'p-does-not-exist'), [])
  assert.deepEqual(assignableOn(ANSWER, null), [])
  assert.deepEqual(assignableOn({}, 'p1'), [])
}

// 3. A handle with no profile is dropped rather than offered: it would render as a nameless option and would be
//    refused by the collector if picked.
{
  const partial: ProjectsAnswer = { ok: true, agents: [], projects: [{ id: 'p1', name: 'b', assignable: ['ghost'] }] }
  assert.deepEqual(assignableOn(partial, 'p1'), [])
}

// 4. Changing the board keeps an addressee only if the new board can receive work from them — otherwise the
//    choice is cleared here, instead of being sent and refused after everything has been typed.
{
  assert.equal(keepAssignee('huester', assignableOn(ANSWER, 'p1')), 'huester', 'still assignable → kept')
  assert.equal(keepAssignee('huester', assignableOn(ANSWER, 'p2')), null, 'not on the new board → cleared')
  assert.equal(keepAssignee('nomad', assignableOn(ANSWER, 'p2')), 'nomad', 'a boardless agent survives any board')
  assert.equal(keepAssignee(null, assignableOn(ANSWER, 'p1')), null, 'unaddressed stays unaddressed')
  assert.equal(keepAssignee('huester', []), null, 'an empty board clears the address')
}

// 5. The options: "никому" first and selected by default, then a person per line, with the role in the tooltip.
{
  const html = assigneeOptionsHtml(assignableOn(ANSWER, 'p1'), null, true)
  assert.ok(html.startsWith(`<option value=""`), '"никому" is the first option')
  assert.ok(html.includes(`${ASSIGNEE_NOBODY_LABEL}`), 'and carries the default label')
  assert.ok(html.includes('<option value="" selected>'), 'unaddressed is what is selected')
  assert.ok(html.includes('>huester — Агент tester-huester<'), 'handle AND title, so a person is picked, not a slug')
  assert.ok(html.includes('title="Делает доску и расширение."'), 'the role explains who that is on hover')
  assert.ok(html.includes(`title="${ROLE_UNDESCRIBED}"`), 'an agent that never described itself says so')
  assert.ok(html.includes('>nomad<'), 'a titleless agent is offered under its bare handle')
}

// 6. A chosen addressee is the selected option, and "никому" is then NOT selected.
{
  const html = assigneeOptionsHtml(assignableOn(ANSWER, 'p2'), 'erental', true)
  assert.ok(html.includes('<option value="erental" title="Ведёт прокатный проект." selected>'), 'the choice is selected')
  assert.ok(!html.includes('<option value="" selected>'), '"никому" gives up the selection')
}

// 7. Empty vs unavailable are different sentences: one is a fact about the board, the other is a failure the
//    reporter must see. Neither is an empty dropdown, which just looks broken.
{
  const empty = assigneeOptionsHtml([], null, true)
  assert.ok(empty.includes(ASSIGNEE_NONE_ON_BOARD_LABEL), 'a board with no agents says so')
  assert.ok(!empty.includes(ASSIGNEE_NOBODY_LABEL), 'and does not pretend there is a choice to make')
  const blind = assigneeOptionsHtml([], null, false)
  assert.ok(blind.includes(ASSIGNEE_UNAVAILABLE_LABEL), 'a roster that never arrived says THAT instead')
}

// 8. Markup from the server is escaped: a title is free text an agent wrote about itself, and it lands inside
//    an attribute and a text node.
{
  const nasty: ProjectsAnswer = {
    ok: true,
    agents: [{ handle: 'x', title: '<b>"жирный"</b>', role: 'ломает" onmouseover="alert(1)' }],
    projects: [{ id: 'p1', name: 'b', assignable: ['x'] }],
  }
  const html = assigneeOptionsHtml(assignableOn(nasty, 'p1'), null, true)
  assert.ok(!html.includes('<b>'), 'tags are escaped')
  assert.ok(!html.includes('onmouseover="'), 'the tooltip cannot break out of its attribute')
}

console.log('extension: roster picker tests passed ✓')
