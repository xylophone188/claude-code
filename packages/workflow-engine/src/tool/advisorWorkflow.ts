/** Built-in one-pass advisor orchestration. Heavy work stays on `auto`; an
 * advisor plans, reviews, then performs one bounded acceptance retry. */
export function createAdvisorWorkflowScript(): string {
  return `export const meta = {
  name: 'advisor',
  description: 'Advisor plans, auto executes, advisor accepts',
  phases: [
    { title: 'Plan' },
    { title: 'Execute' },
    { title: 'Review' },
    { title: 'Revision' },
    { title: 'Acceptance' },
  ],
}

const task = typeof args === 'string' ? args : args && typeof args.task === 'string' ? args.task : ''
if (!task) throw new Error('advisor workflow requires args.task')

const PLAN = {
  type: 'object',
  required: ['plan', 'acceptance'],
  additionalProperties: false,
  properties: {
    plan: { type: 'string' },
    acceptance: { type: 'array', items: { type: 'string' } },
  },
}
const REVIEW = {
  type: 'object',
  required: ['accepted', 'revisions', 'summary'],
  additionalProperties: false,
  properties: {
    accepted: { type: 'boolean' },
    revisions: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

phase('Plan')
const plan = await agent(
  'Act only as senior advisor. Turn this task into a concrete implementation plan and acceptance criteria. Do not edit files.\\n\\nTask:\\n' + task,
  { model: 'advisor', agentType: 'workflow-advisor', label: 'advisor:plan', schema: PLAN },
)
if (!plan) throw new Error('advisor plan did not complete')

phase('Execute')
const execution = await agent(
  'Execute this task in the current workspace. Make the changes, run relevant checks, and report exact results.\\n\\nTask:\\n' + task + '\\n\\nApproved plan:\\n' + JSON.stringify(plan),
  { model: 'auto', label: 'auto:execute' },
)
if (!execution) throw new Error('auto execution did not complete')

phase('Review')
let review = await agent(
  'Act only as final reviewer. Inspect the actual workspace and execution result against the plan and acceptance criteria. Decide whether it is accepted. List only necessary revision tasks. Do not edit files.\\n\\nTask:\\n' + task + '\\n\\nPlan:\\n' + JSON.stringify(plan) + '\\n\\nExecution result:\\n' + String(execution),
  { model: 'advisor', agentType: 'workflow-advisor', label: 'advisor:review', schema: REVIEW },
)
if (!review) throw new Error('advisor review did not complete')

let revision = null
if (review && !review.accepted && review.revisions.length) {
  phase('Revision')
  revision = await agent(
    'Apply only these reviewer-requested revisions in the current workspace, run relevant checks, and report exact results.\\n\\nTask:\\n' + task + '\\n\\nRevisions:\\n' + review.revisions.join('\\n'),
    { model: 'auto', label: 'auto:revision' },
  )
  if (!revision) throw new Error('auto revision did not complete')
}

phase('Acceptance')
const acceptance = await agent(
  'Perform final acceptance. Inspect the actual workspace, execution result, review, and any revision. Verify the acceptance criteria. Do not edit files.\\n\\nTask:\\n' + task + '\\n\\nPlan:\\n' + JSON.stringify(plan) + '\\n\\nExecution result:\\n' + String(execution) + '\\n\\nReview:\\n' + JSON.stringify(review) + '\\n\\nRevision result:\\n' + String(revision),
  { model: 'advisor', agentType: 'workflow-advisor', label: 'advisor:accept', schema: REVIEW },
)
if (!acceptance) throw new Error('advisor acceptance did not complete')
if (!acceptance.accepted)
  throw new Error('advisor acceptance rejected: ' + acceptance.summary)

return { plan, execution, review, revision, acceptance }`
}
