// Protocol 1.0, architecture 90268a2. No Worker dependencies.
export type Id = string;
export type Hash = string;
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Mode = 'read-only' | 'workspace-write' | 'approval-required' | 'trusted-automation';
export type Boundary = {
  id: Id;
  kind: 'cloud' | 'sovereign';
  issuer: string;
  audience: string;
};
export type Principal = {
  subject: Id;
  tenantId: Id;
  accountId: Id;
  scopes: string[];
};
export type State =
  | 'accepted'
  | 'running'
  | 'awaiting_tool'
  | 'awaiting_approval'
  | 'cancel_requested'
  | 'committed'
  | 'cancelled'
  | 'failed'
  | 'uncertain'
  | 'abandoned';
export interface Limits {
  requestBytes: number;
  contextBytes: number;
  eventBytes: number;
  toolArgsBytes: number;
  receiptBytes: number;
  maxTools: number;
  maxOutputTokens: number;
  maxSteps: number;
}
export interface Capabilities {
  protocol: '1.0';
  boundary: Boundary;
  principal: Principal;
  policyRevision: string;
  features: {
    durableTurns: boolean;
    localTools: boolean;
    durableReceipts: boolean;
    continuations: boolean;
    executionClaims: boolean;
    deltaReplay: boolean;
    memorySearch: boolean;
    projectBinding: boolean;
    usage: boolean;
  };
  limits: Limits;
  models: ModelCapability[];
  defaultModel: string;
  budgetUnit: { currency: string; scale: 1000000 } | null;
}
export interface ModelCapability {
  id: string;
  label: string;
  eligible: boolean;
  text: boolean;
  tools: boolean;
  streaming: boolean;
  contextTokens: number | null;
  maxOutputTokens: number;
  efforts: string[];
  selection: 'automatic' | 'preferred' | 'strict';
}
export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  estimated: boolean;
  percentUsed: number | null;
  dailyPercentUsed: number | null;
  paused: boolean;
  cost: {
    amountMicro: number;
    currency: string;
    basis: 'settled' | 'estimate';
  } | null;
  chargedAmountMicro: number | null;
  billingUrl: string | null;
}
export interface OpenSession {
  openId: Id;
  conversationId?: Id;
  projectId?: Id;
  workspace: { id: Id; rootHash: Hash; revision: string }; // no absolute host path
  level: 'A' | 'B';
  mode: Mode;
  tools: ToolDescriptor[];
}
export interface Accepted {
  sessionId: Id;
  commandId: Id;
  state: 'accepted';
  revision: number;
}
export interface SessionSnapshot {
  sessionId: Id;
  conversationId: Id;
  principal: Principal;
  boundary: Boundary;
  revision: number;
  conversationSeq: number;
  eventCursor: number;
  taskId: Id | null;
  active: CommandSnapshot[];
  policyRevision: string;
}
export interface SubmitCommand {
  commandId: Id;
  expectedRevision: number;
  kind: 'message' | 'task';
  text: string;
  model: string;
  effort?: string;
  context: ContextRef[];
  memory: MemoryRef[];
  budget: {
    maxSteps: number;
    maxWallMs: number;
    maxCostMicro: number | null;
    maxToolCalls?: number;
    maxOutputTokens?: number;
    maxContextTokens?: number;
  }; // currency/billing unit provided by deployment
}
export interface CommandSnapshot {
  sessionId: Id;
  commandId: Id;
  parentCommandId: Id | null;
  state: State;
  revision: number;
  conversationSeq: number;
  result: Json | null;
  unresolvedTools: Id[];
  usage: Usage | null;
  error: AgentError | null;
  execution: {
    state: 'ready' | 'claimed' | 'recorded' | 'uncertain' | 'denied';
    claimId: Id | null;
    executorId: Id | null;
    argsHash: Hash;
    receiptHash: Hash | null;
  } | null;
}
export interface ContextRef {
  path?: string;
  id: Id;
  sha256: Hash;
  revision: string;
}
export interface ContextChunk {
  path: string;
  sha256: Hash;
  content: string;
  revision: string;
  origin: 'user' | 'repository' | 'tool';
  trust: 'user-input' | 'untrusted-data';
  classification: 'project' | 'sensitive-approved';
  consentId: Id;
}
export interface MemoryRef {
  id: Id;
  scope: 'user' | 'project' | 'conversation';
  projectId: Id | null;
  version: string;
}
export type Action = 'read' | 'write' | 'execute' | 'network' | 'git-history' | 'destructive' | 'production';
export interface ToolDescriptor {
  name: string;
  version: string;
  inputSchema: Json;
  actions: Action[];
  retryClass: 'read' | 'idempotent-verified' | 'non-idempotent';
}
export interface ToolRequest {
  commandId: Id;
  parentCommandId: Id;
  tool: string;
  toolVersion: string;
  args: Json;
  argsHash: Hash;
  workspaceId: Id;
  expectedWorkspaceRevision: string;
  policyRevision: string;
  expiresAt: number; // advisory remote restrictions, not a grant
}
export interface ApprovalRequest {
  id: Id;
  commandId: Id;
  actionHash: Hash;
  summary: string;
  actions: Action[];
  expiresAt: number;
}
export interface ApprovalDecision {
  id: Id;
  commandId: Id;
  actionHash: Hash;
  decision: 'allow-once' | 'deny';
  localDecisionId: Id;
  policyRevision: string;
}
export interface ClaimRequest {
  claimId: Id;
  executorId: Id;
  argsHash: Hash;
  approvalDecisionId: Id | null;
  policyRevision: string;
}
export type ClaimResponse =
  | { granted: true; executionToken: string; claimId: Id }
  | { granted: false; state: 'claimed' | 'recorded' | 'uncertain' | 'denied' };
export interface ExecutionReceipt {
  receiptId: Id;
  sessionId: Id;
  commandId: Id;
  parentCommandId: Id;
  claimId: Id;
  executorId: Id;
  argsHash: Hash;
  workspaceId: Id;
  policyRevision: string;
  approvalDecisionId: Id | null;
  state: 'succeeded' | 'failed-known' | 'denied' | 'cancelled-known' | 'uncertain';
  startedAt: number | null;
  endedAt: number;
  exitCode: number | null;
  signal: string | null;
  output: {
    sha256: Hash;
    excerpt: string;
    bytes: number;
    truncated: boolean;
  } | null;
  effects: Array<{
    path: string;
    beforeHash: Hash | null;
    afterHash: Hash | null;
    status: 'verified' | 'unknown';
  }>;
  result: Json | null; // schema-validated, bounded, untrusted tool result
  evidence: string[]; // local evidence IDs, never arbitrary remote URLs
  receiptHash: Hash;
}
export interface ReceiptAck {
  recorded: true;
  commandId: Id;
  receiptHash: Hash;
  revision: number;
}
export interface CancelRequest {
  cancelId: Id;
  commandId: Id;
  reason: 'user' | 'timeout' | 'policy';
}
export interface Resolution {
  resolutionId: Id;
  commandId: Id;
  disposition: 'verified-complete' | 'verified-no-effect' | 'abandon';
  evidence: string[];
  receiptHash: Hash | null;
}
export interface AgentError {
  code:
    | 'UNAUTHENTICATED'
    | 'FORBIDDEN'
    | 'TENANT_MISMATCH'
    | 'POLICY_DENIED'
    | 'MODEL_UNAVAILABLE'
    | 'CAPABILITY_MISSING'
    | 'PROTOCOL_UNSUPPORTED'
    | 'QUOTA_EXCEEDED'
    | 'RATE_LIMITED'
    | 'CONTEXT_TOO_LARGE'
    | 'REVISION_CONFLICT'
    | 'COMMAND_CONFLICT'
    | 'TURN_UNRESOLVED'
    | 'EXECUTION_UNCERTAIN'
    | 'CURSOR_EXPIRED'
    | 'REQUEST_EXPIRED'
    | 'INVALID_REQUEST'
    | 'INTERNAL';
  message: string;
  commandId: Id | null;
  retry: 'never' | 'read-status' | 'same-id-after-delay';
  retryAfterMs: number | null;
}
export type EventPayload =
  | { t: 'ping' }
  | { t: 'phase'; phase: string }
  | { t: 'delta'; text?: string; reset?: true; provisional: true }
  | { t: 'tool_request'; request: ToolRequest }
  | { t: 'approval_request'; approval: ApprovalRequest }
  | { t: 'receipt_ack'; ack: ReceiptAck }
  | { t: 'usage'; usage: Usage }
  | { t: 'state'; snapshot: CommandSnapshot }
  | { t: 'result'; status: number; body: CommandSnapshot }
  | { t: 'error'; error: AgentError };
export type AgentEvent = EventPayload & {
  v: '1.0';
  sessionId: Id;
  commandId: Id | null;
  eventId: Id;
  cursor: number | null;
  revision: number;
};

export interface ModuleFailure {
  code: string;
  message: string;
  retryable: boolean;
  uncertain: boolean;
}
export interface CredentialHandle {
  id: Id;
  profile: string;
} // secret accessible only to broker/client
export interface WorkspaceHandle {
  id: Id;
  root: string;
  revision: string;
  boundaryId: Id;
}
export interface AuthorizedPath {
  relative: string;
  canonical: string;
  identity: string;
}
export interface EffectPlan {
  commandId: Id;
  hash: Hash;
  workspaceId: Id;
  actions: Action[];
  paths: string[];
  executable?: string;
  argv?: string[];
  networkOrigins: string[];
  timeoutMs: number;
  maxOutputBytes: number;
}
export type Decision =
  | { kind: 'deny'; reason: string }
  | { kind: 'prompt'; request: ApprovalRequest }
  | { kind: 'allow'; grant: LocalGrant };
export interface LocalGrant {
  id: Id;
  planHash: Hash;
  workspaceId: Id;
  policyRevision: string;
  expiresAt: number;
  actions: Action[]; // opaque validated local authority, not a model token
}
export interface Checkpoint {
  id: Id;
  workspaceId: Id;
  manifestHash: Hash;
  commandId: Id;
}
export interface PatchFile {
  path: string;
  beforeHash: Hash | null;
  after: string | null;
}
export interface PatchPlan {
  id: Id;
  files: PatchFile[];
  hash: Hash;
  workspaceId: Id;
}
export interface JournalRecord {
  id: Id;
  commandId: Id;
  state: string;
  body: Json;
  at: number;
}
export interface CliSessionManager {
  open(input: OpenSession, credential: CredentialHandle): Promise<SessionSnapshot>;
  resume(id: Id, workspace: WorkspaceHandle): Promise<SessionSnapshot>;
  submit(command: SubmitCommand): Promise<Accepted>;
  consume(signal: AbortSignal): AsyncIterable<AgentEvent>;
  cancel(commandId: Id): Promise<CommandSnapshot>;
  recover(id: Id): Promise<CommandSnapshot[]>;
}
export interface CortexClient {
  capabilities(signal: AbortSignal): Promise<Capabilities>;
  open(input: OpenSession): Promise<SessionSnapshot>;
  snapshot(id: Id): Promise<SessionSnapshot>;
  submit(session: Id, command: SubmitCommand): Promise<Accepted>;
  status(session: Id, command: Id): Promise<CommandSnapshot>;
  events(session: Id, after: number, signal: AbortSignal): AsyncIterable<AgentEvent>;
  claim(session: Id, tool: Id, input: ClaimRequest): Promise<ClaimResponse>;
  receipt(input: ExecutionReceipt, executionToken?: string): Promise<ReceiptAck>;
  approve(session: Id, decision: ApprovalDecision): Promise<void>;
  cancel(session: Id, input: CancelRequest): Promise<CommandSnapshot>;
  resolve(session: Id, input: Resolution): Promise<CommandSnapshot>;
}
export interface AuthenticationProvider {
  login(profile: string, method: 'device' | 'token' | 'enterprise'): Promise<CredentialHandle>;
  principal(handle: CredentialHandle): Promise<Principal>;
  revoke(handle: CredentialHandle): Promise<{ remoteRevoked: boolean; pending: boolean }>;
}
export interface WorkspaceManager {
  open(root: string, boundary: Boundary): Promise<WorkspaceHandle>;
  resolve(workspace: WorkspaceHandle, relative: string, action: 'read' | 'write'): Promise<AuthorizedPath>;
  lock(workspace: WorkspaceHandle, executor: Id): Promise<{ release(): Promise<void> }>;
  verify(workspace: WorkspaceHandle, paths: AuthorizedPath[]): Promise<void>;
}
export interface LocalToolRegistry {
  descriptors(): ToolDescriptor[];
  plan(request: ToolRequest, workspace: WorkspaceHandle): Promise<EffectPlan>;
  execute(request: ToolRequest, grant: LocalGrant, signal: AbortSignal): Promise<ExecutionReceipt>;
}
export interface PermissionEngine {
  evaluate(plan: EffectPlan, mode: Mode): Promise<Decision>;
  approve(request: ApprovalRequest, plan: EffectPlan, decision: 'allow-once' | 'deny'): Promise<Decision>;
  validate(grant: LocalGrant, plan: EffectPlan): Promise<void>;
}
export interface ExecutionSupervisor {
  run(plan: EffectPlan, grant: LocalGrant, signal: AbortSignal): Promise<ExecutionReceipt>;
  cancel(command: Id): Promise<{ terminated: boolean; effectsKnown: boolean }>;
  reconcile(command: Id): Promise<ExecutionReceipt | null>;
}
export interface PatchManager {
  prepare(workspace: WorkspaceHandle, files: PatchFile[]): Promise<PatchPlan>;
  apply(plan: PatchPlan, grant: LocalGrant): Promise<ExecutionReceipt>;
  checkpoint(plan: PatchPlan): Promise<Checkpoint>;
  restore(checkpoint: Checkpoint, grant: LocalGrant): Promise<ExecutionReceipt>;
  reconcile(planId: Id): Promise<'applied' | 'not-applied' | 'partial' | 'unknown'>;
}
export interface GitAdapter {
  inspect(workspace: WorkspaceHandle): Promise<{ head: string | null; dirty: string[] }>;
  diff(workspace: WorkspaceHandle, paths: string[]): Promise<string>;
  plan(
    workspace: WorkspaceHandle,
    action: 'stage' | 'commit' | 'push' | 'restore',
    args: Json,
  ): Promise<EffectPlan>;
  execute(plan: EffectPlan, grant: LocalGrant, signal: AbortSignal): Promise<ExecutionReceipt>;
}
export interface RecoveryJournal {
  append(record: JournalRecord): Promise<void>; // commits durably before returning
  transition(command: Id, from: string, to: string, body: Json): Promise<void>; // CAS
  pending(): Promise<JournalRecord[]>;
  receipt(command: Id): Promise<ExecutionReceipt | null>;
  checkpoint(value: Checkpoint): Promise<void>;
  prune(now: number): Promise<{ removed: number; retainedUnresolved: number }>;
}
export interface ContextProvider {
  collect(workspace: WorkspaceHandle, paths: string[], consentId: Id): Promise<ContextChunk[]>;
  incremental(previous: ContextRef[], chunks: ContextChunk[]): Promise<ContextChunk[]>;
  fit(chunks: ContextChunk[], availableTokens: number): Promise<ContextChunk[]>;
}
export interface ModelCapabilityProvider {
  list(): Promise<ModelCapability[]>;
  select(preference: string, requirements: { tools: boolean; minContext: number }): Promise<ModelCapability>;
  invalidate(): void;
}
