import * as z from 'zod/v4';
import { execute as executeBoard } from './board/board.mjs';

const short = z.string().trim().min(1).max(200);
const list = z.array(z.string().trim().min(1).max(2000)).max(32).optional();
const reference = z.object({ ref: z.string().trim().min(1).max(2000), version: short }).strict();
const criteria = z.array(z.object({ id: short, description: z.string().trim().min(1).max(2000) }).strict()).max(12);
const context = z.object({
  inputs: z.array(reference).max(12).optional(),
  constraints: z.array(z.string().trim().min(1).max(2000)).max(16).optional(),
  skills: z.array(z.string().trim().min(1).max(2000)).max(16).optional(),
}).strict();
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const preservedText = z.string().min(1).max(2000).refine(value => value.trim().length > 0, 'Must contain non-whitespace text');
const evidence = z.array(preservedText).max(12);
const workspace = z.string().min(1).describe('Absolute path of the user-authorized project. Legacy board state is stored in .super-teams when DSH_SUPER_TEAMS_LEGACY=1.');
const common = {
  workspace,
  team_id: short,
  expected_revision: z.number().int().positive(),
  request_id: short.describe('Unique stable operation ID. Retry identical arguments with the same ID; use a new ID after revising an operation.'),
};

const checkSchema = z.object({
  type: z.enum(['file_exists', 'file_contains', 'json_equals', 'node_test', 'command_test']),
  path: z.string().min(1).optional(),
  value: z.string().optional(),
  pointer: z.string().optional(),
  expected: z.unknown().describe('Expected JSON value for json_equals').optional(),
  sourceId: z.string().optional(),
  sha256: z.string().optional(),
  testScript: z.string().min(1).max(16384).optional().describe('Trusted CommonJS behavioral test script for node_test (receives checked artifact path as process.argv[1]; exit 0 = pass). Hashed and stored in team ContextStore at plan creation time.'),
  command: z.enum(['node', 'pytest', 'python', 'python3', 'cargo', 'go', 'dotnet', 'npm']).optional().describe('Structured local test runner for command_test (npx and inline eval flags are forbidden).'),
  args: z.array(z.string().min(1).max(512)).max(32).optional().describe('Structured arguments for command_test (e.g. ["--test", "tests/app.test.mjs"], ["-m", "pytest"], ["test"]).'),
  timeoutMs: z.number().int().min(100).max(120000).optional(),
}).strict();

const schedulingFields = {
  priority: z.enum(['critical', 'high', 'normal', 'low']).optional(),
  writeScopes: z.array(z.string().min(1).max(240)).max(16).optional().describe('Declared relative write scopes. Enforced by runtime scheduler mutex (serializes overlapping concurrent tasks) and post-run workspace verification / git-worktree two-tree diff (fails undeclared writes).'),
  autoAccept: z.boolean().optional().describe('Requires at least one immutable ContextStore-frozen node_test check. command_test and structural checks reach "checked" state and require explicit review/accept.'),
  maxRetries: z.number().int().min(0).max(3).optional(),
};

const planTaskSchema = z.object({
  key: z.string().min(1).max(100),
  member: z.string().min(1),
  title: z.string().min(1),
  goal: z.string().min(1),
  difficulty: z.enum(['low', 'medium', 'high']).optional(),
  dependsOn: z.array(z.string()).optional(),
  checks: z.array(checkSchema).optional(),
  ...schedulingFields,
}).strict();

const windowFields = {
  cursor: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  budgetBytes: z.number().int().min(1024).max(65536).optional(),
};

const goalCriterionSchema = z.object({
  id: z.string().min(1).max(120).optional(),
  requirementText: z.string().min(1).max(2000),
  mandatory: z.boolean().optional(),
  verificationMode: z.enum(['check', 'human_signoff']).optional(),
  sourceSegmentIds: z.array(z.string().min(1).max(64)).max(16).optional(),
  sourceQuote: z.string().min(1).max(2000).optional(),
  checkId: z.string().min(1).max(120).optional(),
  checkSpec: checkSchema.optional(),
  taskId: z.string().min(1).max(120).optional(),
  signoffRole: z.string().min(1).max(120).optional(),
}).strict();

const unmappedDispositionSchema = z.object({
  segmentId: z.string().min(1).max(64),
  action: z.enum(['deferred', 'out_of_scope', 'merged_into_criterion']),
  reason: z.string().min(1).max(1000),
  criterionId: z.string().min(1).max(120).optional(),
}).strict();

const primaryRawDefinitions = [
  [
    'engine_workspace',
    'Open and focus the SuperAgent Team Workbench in the DeepSeek Harness right sidebar for the current chat session (optionally binding/focusing a specific teamId in the durable engine.sqlite store).',
    z.object({
      teamId: z.string().min(1).optional(),
    }).strict(),
  ],
  [
    'engine_team',
    'Manage durable SQLite-persisted teams, frozen goal criteria (R2), immutable delivery candidates & bound approvals (R3-R6), atomic local branch publish, read-only GitHub PR reconciliation (R7-R8), budget guards, repo probing, and remote PR delivery (v0.19) in the single engine store.',
    z.object({
      action: z.enum(['prepare', 'create', 'list', 'overview', 'graph', 'accept_checked', 'merge_preview', 'merge_apply', 'criteria_get', 'criteria_preview', 'criteria_freeze', 'criteria_signoff', 'candidate_create', 'candidate_list', 'candidate_get', 'candidate_approve', 'approval_revoke', 'candidate_publish_local', 'publish_reconcile', 'candidate_base_drift', 'pr_reconcile', 'budget_get', 'budget_set', 'repo_probe', 'env_recipe_approve', 'security_posture', 'remote_push', 'remote_pr_create', 'remote_reconcile', 'remote_unknown_resolve', 'remote_event_ingest', 'remote_drift_resolve', 'rebind_session', 'pause', 'resume', 'cancel', 'archive', 'unarchive']),
      teamId: z.string().optional(),
      sessionId: z.string().trim().min(1).max(180).optional(),
      requestId: z.string().optional(),
      name: z.string().optional(),
      goal: z.string().optional(),
      rawGoal: z.string().optional(),
      workspaceMode: z.enum(['isolated', 'git-worktree']).optional(),
      repoPath: z.string().min(1).max(1000).optional(),
      branchName: z.string().min(1).max(100).optional(),
      targetRef: z.string().min(1).max(200).optional(),
      allowPartial: z.boolean().optional(),
      integrationCheck: checkSchema.optional(),
      criteria: z.array(goalCriterionSchema).max(32).optional(),
      dispositions: z.array(unmappedDispositionSchema).max(32).optional(),
      confirmedBy: z.string().min(1).max(200).optional(),
      criterionId: z.string().min(1).max(120).optional(),
      signer: z.string().min(1).max(200).optional(),
      note: z.string().max(2000).optional(),
      candidateId: z.string().min(1).max(120).optional(),
      parentCandidateId: z.string().min(1).max(120).optional(),
      taskIds: z.array(z.string().min(1)).max(64).optional(),
      approvalId: z.string().min(1).max(120).optional(),
      purpose: z.enum(['local_publish', 'draft_pr', 'request_merge', 'remote_push']).optional(),
      reason: z.string().max(2000).optional(),
      repo: z.string().min(1).max(200).optional(),
      prNumber: z.number().int().min(1).optional(),
      headRepo: z.string().min(1).max(200).optional(),
      headBranch: z.string().min(1).max(200).optional(),
      baseBranch: z.string().min(1).max(200).optional(),
      expectedIntentId: z.string().min(1).max(120).optional(),
      linkId: z.string().min(1).max(120).optional(),
      budget: z.object({
        maxTeamAttempts: z.number().int().min(1).nullable().optional(),
        maxInFlight: z.number().int().min(1).nullable().optional(),
        maxTaskDurationMs: z.number().int().min(100).nullable().optional(),
        maxTeamTokensSoft: z.number().int().min(1).nullable().optional(),
        sameErrorBreakerThreshold: z.number().int().min(1).nullable().optional(),
      }).strict().optional(),
      allowedRemoteRepos: z.array(z.string().min(1)).max(32).optional(),
      deliveryStreamId: z.string().min(1).max(120).optional(),
      remoteUrl: z.string().min(1).max(1000).optional(),
      stableBranch: z.string().min(1).max(200).optional(),
      expectedOldOid: z.string().min(1).max(120).optional(),
      title: z.string().min(1).max(300).optional(),
      body: z.string().max(8000).optional(),
      draft: z.boolean().optional(),
      intentId: z.string().min(1).max(120).optional(),
      checkSignature: z.string().min(1).max(200).optional(),
      failureSummary: z.string().max(4000).optional(),
      memberId: z.string().min(1).max(120).optional(),
      newBranch: z.string().min(1).max(200).optional(),
      selectedCommands: z.array(z.unknown()).max(16).optional(),
      setupCommand: z.string().max(500).optional(),
      envVars: z.record(z.string(), z.string()).optional(),
      approvedBy: z.string().min(1).max(200).optional(),
      requireGoalPassed: z.boolean().optional(),
      members: z.array(z.object({
        name: z.string().min(1),
        role: z.string().min(1),
        responsibility: z.string().min(1),
      }).strict()).min(1).max(12).optional(),
      tasks: z.array(planTaskSchema).min(1).max(24).optional(),
      attentionOnly: z.boolean().optional(),
      ...windowFields,
    }).strict(),
  ],
  [
    'engine_submit',
    'Submit one persistent task or integration revision task (via revisionOfCandidateId + affectedTaskIds on git-worktree teams) into engine.sqlite with stable requestId, difficulty, optional priority/writeScopes/autoAccept/maxRetries, dependencies, sources and objective checks.',
    z.object({
      requestId: z.string().min(1),
      title: z.string().min(1),
      goal: z.string().min(1),
      teamId: z.string().optional(),
      memberId: z.string().optional(),
      difficulty: z.enum(['low', 'medium', 'high']).optional(),
      dependsOn: z.array(z.string()).optional(),
      sourceIds: z.array(z.string()).optional(),
      checks: z.array(checkSchema).optional(),
      revisionOfCandidateId: z.string().min(1).max(100).optional(),
      affectedTaskIds: z.array(z.string().min(1)).max(32).optional(),
      ...schedulingFields,
    }).strict(),
  ],
  [
    'engine_overview',
    'Read byte-bounded task summaries and counts from the durable SQLite engine store. Set attentionOnly=true for tasks needing a human/lead decision; supply teamId to scope to one team.',
    z.object({
      teamId: z.string().optional(),
      attentionOnly: z.boolean().optional(),
      ...windowFields,
    }).strict(),
  ],
  [
    'engine_control',
    'Inspect, control, verify, accept, freeze, rework, abandon or release an unresolved abandoned slot on an engine task. accept freezes registered artifacts/result into SHA-256 disk snapshots (failed host requires acknowledgeHostFailure=true and reason). rework sends reviewer feedback (via reason) with prior failed checks to re-run a task. abandon ends business follow-up on unknown execution while preserving occupied capacity; resolve_unresolved releases the occupied slot after operator verification with expectedRevision, reason and evidence.',
    z.object({
      taskId: z.string().min(1),
      action: z.enum(['inspect', 'pause', 'resume', 'cancel', 'reconcile', 'retry', 'rework', 'verify', 'accept', 'freeze', 'abandon', 'resolve_unresolved']),
      expectedRevision: z.number().int().min(0).optional(),
      expectedAttemptId: z.string().min(1).max(120).optional(),
      reason: z.string().max(4000).optional(),
      acknowledgeHostFailure: z.boolean().optional(),
      evidence: z.string().max(4000).optional(),
    }).strict(),
  ],
  [
    'engine_source',
    'Store SHA-256 verified source text on disk. Pass teamId for team-private context; critical=true constraints are included verbatim and kind=ruling architectural decisions are automatically attached to subsequent team dispatches.',
    z.object({
      teamId: z.string().optional(),
      text: z.string().min(1),
      label: z.string().optional(),
      critical: z.boolean().optional(),
      kind: z.enum(['document', 'log', 'stdout', 'stderr', 'trusted-acceptance-test', 'ruling']).optional(),
    }).strict(),
  ],
  [
    'engine_evidence',
    'Read a UTF-8 byte window of a persisted task result or original registered source (pass teamId for team sources or membership check).',
    z.object({
      kind: z.enum(['result', 'source']),
      id: z.string().min(1),
      teamId: z.string().optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(4).max(16384).optional(),
    }).strict(),
  ],
  [
    'teams_engine',
    'Read-only Super Teams projection of the exact same durable engine.sqlite state (not a second database and not independent verification). Prefer engine_overview / engine_team / engine_control by default; use this only when reading via the /super-teams workflow.',
    z.object({
      action: z.enum(['list', 'overview', 'graph', 'task', 'evidence', 'events']),
      team_id: short.optional(),
      task_id: short.optional(),
      attentionOnly: z.boolean().optional(),
      cursor: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(65536).optional(),
      budgetBytes: z.number().int().min(1024).max(65536).optional(),
      offset: z.number().int().nonnegative().optional(),
      after: z.number().int().nonnegative().optional(),
    }).strict(),
  ],
];

const legacyRawDefinitions = [
  [
    'teams_create',
    'Legacy compatibility mode only (DSH_SUPER_TEAMS_LEGACY=1): create one .super-teams project board.',
    z.object({ workspace, title: short, request_id: short }).strict(),
  ],
  [
    'teams_read',
    'Legacy compatibility mode only: read a .super-teams board (status|results|overview|graph) or engine:<uuid> read-only projection.',
    z.object({
      workspace: workspace.optional(),
      team_id: short.optional(),
      task_id: short.optional(),
      view: z.enum(['status', 'results', 'overview', 'graph']).optional(),
      cursor: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      history: z.boolean().optional(),
    }).strict(),
  ],
  [
    'teams_task_create',
    'Legacy compatibility mode only: create a pending task on a .super-teams board.',
    z.object({
      ...common,
      subject: short,
      acceptance: z.string().trim().min(1).max(4000),
      criteria: criteria.optional(),
      blocked_by: list,
      write_scopes: list,
      context: context.optional(),
    }).strict(),
  ],
  [
    'teams_task_update',
    'Legacy compatibility mode only: claim, edit, checkpoint, complete, release or reopen a .super-teams board task.',
    z.object({
      ...common,
      task_id: short,
      task_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
      action: z.enum(['claim', 'edit', 'checkpoint', 'complete', 'release', 'reopen']),
      owner: short.optional(),
      subject: short.optional(),
      acceptance: z.string().trim().min(1).max(4000).optional(),
      blocked_by: list,
      write_scopes: list,
      context: context.optional(),
      criteria: criteria.optional(),
      outcome: z.enum(['progress', 'blocked', 'ready']).optional(),
      summary: z.string().trim().min(1).max(2000).optional(),
      evidence: z.array(z.string().trim().min(1).max(2000)).max(12).optional(),
      next: z.string().max(2000).optional(),
      stopped: z.boolean().optional(),
    }).strict(),
  ],
  [
    'teams_task_packet',
    'Legacy compatibility mode only: read versioned task packet from a .super-teams board.',
    z.object({ workspace: workspace.optional(), team_id: short.optional(), task_id: short }).strict(),
  ],
  [
    'teams_submit_result',
    'Legacy compatibility mode only: submit versioned result to a .super-teams board.',
    z.object({
      ...common,
      task_id: short,
      task_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      outcome: z.enum(['ready', 'blocked', 'failed']),
      summary: z.string().trim().min(1).max(1200),
      artifacts: z.array(reference).max(12),
      checks: z.array(z.object({
        name: short,
        status: z.enum(['passed', 'failed', 'not_run']),
        evidence: preservedText,
        criterion_ids: z.array(short).max(12).optional(),
        artifacts: z.array(reference).max(12).optional(),
      }).strict()).max(12),
      review: z.enum(['self', 'independent']),
      risks: z.array(preservedText).max(12),
      next: z.string().max(2000).optional(),
      error: preservedText.optional(),
      usage: z.object({
        source: z.string().trim().min(1).max(1000),
        input_tokens: count,
        output_tokens: count,
        cached_input_tokens: count.optional(),
      }).strict().optional(),
    }).strict(),
  ],
  [
    'teams_observe',
    'Legacy compatibility mode only: save owner snapshot on a .super-teams board.',
    z.object({
      ...common,
      agent_id: short,
      status: z.enum(['running', 'inactive', 'unknown']),
      observed_at: z.string(),
      source: z.string().trim().min(1).max(1000),
      task_id: short.optional(),
      task_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
      progress: z.object({ at: z.string(), summary: preservedText, evidence: evidence.min(1) }).strict().optional(),
      wait: z.object({ reason: z.enum(['model_response', 'tool', 'user', 'dependency', 'review', 'unknown']), next: preservedText, next_owner: short }).strict().nullable().optional(),
      instruction: z.object({ id: short, state: z.enum(['delivered', 'applied']), evidence }).strict().optional(),
      control: z.object({ state: z.enum(['paused', 'resumed']), evidence: evidence.min(1) }).strict().optional(),
      recheck: z.object({ at: z.string(), reason: preservedText, next_owner: short, evidence: evidence.min(1) }).strict().nullable().optional(),
    }).strict(),
  ],
];

const allRawDefinitions = [...primaryRawDefinitions, ...legacyRawDefinitions];

function sanitizeJsonSchemaNode(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(sanitizeJsonSchemaNode);
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '$schema') continue;
    out[k] = sanitizeJsonSchemaNode(v);
  }
  return out;
}

const compileDefinitions = defs => defs.map(([name, description, schema]) => ({
  name,
  description,
  parameters: sanitizeJsonSchemaNode(JSON.parse(JSON.stringify(z.toJSONSchema(schema, { io: 'input' })))),
}));

export const primaryToolSchemas = compileDefinitions(primaryRawDefinitions);
export const legacyToolSchemas = compileDefinitions(legacyRawDefinitions);
export const toolSchemas = [...primaryToolSchemas, ...legacyToolSchemas];

export function parseToolInput(name, args) {
  const entry = allRawDefinitions.find(item => item[0] === name);
  if (!entry) throw new Error(`Unknown tool: ${name}`);
  return entry[2].parse(args);
}

export function executeStandaloneBoard(name, parsedArgs) {
  return JSON.parse(JSON.stringify(executeBoard(name, parsedArgs), (key, value) =>
    key === 'runtime_source' && typeof value === 'string'
      ? value.replace('native Codex collaboration tools', 'native DeepSeek Harness subagent tools')
      : value
  ));
}
