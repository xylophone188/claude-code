/** Built-in bounded advisor orchestration. Advisors split and verify; workers
 * investigate in parallel; one executor changes the shared workspace. */
export function createAdvisorWorkflowScript(): string {
  return `export const meta = {
 name: 'advisor',
 description: 'Advisor splits, workers verify, auto executes, advisor accepts',
 phases: [
 { title: 'Plan' },
 { title: 'Workers' },
 { title: 'Lead' },
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
 required: ['plan', 'acceptance', 'subtasks'],
 additionalProperties: false,
 properties: {
 plan: { type: 'string' },
 acceptance: { type: 'array', items: { type: 'string' } },
 subtasks: {
 type: 'array',
 minItems: 1,
 maxItems: 3,
 items: {
 type: 'object',
 required: ['title', 'kind', 'prompt'],
 additionalProperties: false,
 properties: {
 title: { type: 'string' },
 kind: { enum: ['local-code', 'web', 'external', 'reasoning'] },
 prompt: { type: 'string' },
 },
 },
 },
 },
}
const WORKER = {
 type: 'object',
 required: ['status', 'summary', 'evidence'],
 additionalProperties: false,
 properties: {
 status: { enum: ['complete', 'blocked'] },
 summary: { type: 'string' },
 evidence: { type: 'array', items: { type: 'string' } },
 },
}
const LEAD = {
 type: 'object',
 required: ['accepted', 'brief', 'gaps'],
 additionalProperties: false,
 properties: {
 accepted: { type: 'boolean' },
 brief: { type: 'string' },
 gaps: { type: 'array', items: { type: 'string' } },
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

function isUsefulWorker(result) {
 if (!result || typeof result !== 'object' || Array.isArray(result)) return false
 if (result.status !== 'complete' || typeof result.summary !== 'string') return false
 const summary = result.summary.trim()
 const evidence = Array.isArray(result.evidence)
 ? result.evidence.filter(item => typeof item === 'string' && item.trim())
 : []
 return summary.length >= 16 && summary.length <= 4000 && new Set(summary.replace(/\\s/g, '')).size > 8 && evidence.length > 0
}

phase('Plan')
const plan = await agent(
 'Act only senior advisor. Split task into at most three independent investigation subtasks. Each kind is local-code, web, external, or reasoning. Do not edit files. Return concrete plan and acceptance criteria.\\n\\nTask:\\n' + task,
 { model: 'ccb-plan', agentType: 'workflow-advisor', label: 'advisor:plan', schema: PLAN },
)
const subtasks = plan && Array.isArray(plan.subtasks) ? plan.subtasks.slice(0, 3) : []
if (!plan || !subtasks.length) throw new Error('advisor plan did not produce subtasks')

phase('Workers')
const workers = await parallel(
 subtasks.map((subtask, index) => async () =>
 agent(
 'Act only investigation worker. Do not edit shared workspace. Use only evidence needed for this subtask. Do not automate or mutate external systems unless task explicitly requires it. Return complete only with non-empty evidence; otherwise blocked.\\n\\nTask:\\n' + task + '\\n\\nSubtask:\\n' + JSON.stringify(subtask),
 { model: subtask.kind === 'web' ? 'ccb-search' : 'ccb-research', label: 'auto:worker:' + (index + 1), schema: WORKER },
 ),
 ),
)
const usefulWorkers = workers.filter(isUsefulWorker)
if (!usefulWorkers.length) throw new Error('advisor workers did not return a valid result')

phase('Lead')
let lead = await agent(
 'Act only worker leader. Validate worker evidence against task. Reject unsupported or conflicting results. If accepted, write concise execution brief. If not, list exact gaps. Do not edit files.\\n\\nTask:\\n' + task + '\\n\\nPlan:\\n' + JSON.stringify(plan) + '\\n\\nWorkers:\\n' + JSON.stringify(usefulWorkers),
 { model: 'ccb-review', label: 'auto:lead', schema: LEAD },
)
if (lead && !lead.accepted && Array.isArray(lead.gaps) && lead.gaps.length) {
 phase('Worker repair')
 const repair = await agent(
 'Act only repair worker. Close these leader-identified gaps with evidence. Do not edit shared workspace. Return complete only with non-empty evidence.\\n\\nTask:\\n' + task + '\\n\\nGaps:\\n' + lead.gaps.join('\\n'),
 { model: 'ccb-research', label: 'auto:worker:repair', schema: WORKER },
 )
 if (!isUsefulWorker(repair)) throw new Error('advisor worker repair did not return a valid result')
 lead = await agent(
 'Act only worker leader. Re-evaluate original evidence plus repair. Accept only if gaps are closed. Do not edit files.\\n\\nTask:\\n' + task + '\\n\\nWorkers:\\n' + JSON.stringify(usefulWorkers) + '\\n\\nRepair:\\n' + JSON.stringify(repair),
 { model: 'ccb-review', label: 'auto:lead:retry', schema: LEAD },
 )
}
if (!lead || !lead.accepted) throw new Error('worker leader rejected results')

phase('Execute')
const execution = await agent(
 'Execute task in current workspace. Make only necessary changes, run relevant checks, report exact results.\\n\\nTask:\\n' + task + '\\n\\nApproved execution brief:\\n' + lead.brief,
 { model: 'ccb-coding', label: 'auto:execute' },
)
if (!execution) throw new Error('auto execution did not complete')

phase('Review')
let review = await agent(
 'Act only independent final reviewer. Inspect actual workspace result against plan acceptance criteria and worker evidence. Do not edit files. Decide accepted or list only necessary revisions.\\n\\nTask:\\n' + task + '\\n\\nPlan:\\n' + JSON.stringify(plan) + '\\n\\nLead brief:\\n' + lead.brief + '\\n\\nExecution result:\\n' + String(execution),
 { model: 'ccb-review', agentType: 'workflow-advisor', label: 'auto:review', schema: REVIEW },
)
if (!review) throw new Error('advisor review did not complete')

let revision = null
if (!review.accepted && review.revisions.length) {
 phase('Revision')
 revision = await agent(
 'Apply only reviewer-requested revisions in current workspace, run relevant checks, report exact results.\\n\\nTask:\\n' + task + '\\n\\nRevisions:\\n' + review.revisions.join('\\n'),
 { model: 'ccb-coding', label: 'auto:revision' },
 )
 if (!revision) throw new Error('auto revision did not complete')
}

phase('Acceptance')
const acceptance = await agent(
 'Perform final acceptance. Inspect actual workspace, plan, execution, review, and revision. Verify acceptance criteria. Do not edit files.\\n\\nTask:\\n' + task + '\\n\\nPlan:\\n' + JSON.stringify(plan) + '\\n\\nExecution result:\\n' + String(execution) + '\\n\\nReview:\\n' + JSON.stringify(review) + '\\n\\nRevision result:\\n' + String(revision),
 { model: 'ccb-review', agentType: 'workflow-advisor', label: 'advisor:accept', schema: REVIEW },
)
if (!acceptance) throw new Error('advisor acceptance did not complete')
if (!acceptance.accepted) throw new Error('advisor acceptance rejected: ' + acceptance.summary)

return { plan, workers: usefulWorkers, lead, execution, review, revision, acceptance }`
}
