import tsj from 'typescript-json-schema';
import fs from 'node:fs';
const program = tsj.getProgramFromFiles(['packages/agent-protocol/contracts.ts'], {
  strictNullChecks: true,
  skipLibCheck: true,
});
const names = [
  'Capabilities',
  'OpenSession',
  'SubmitCommand',
  'SessionSnapshot',
  'CommandSnapshot',
  'AgentEvent',
  'ToolRequest',
  'ClaimRequest',
  'ExecutionReceipt',
  'ApprovalDecision',
  'ContextChunk',
  'Resolution',
];
const schemas = Object.fromEntries(
  names.map((n) => [n, tsj.generateSchema(program, n, { required: true, noExtraProps: true, ignoreErrors: false })]),
);
fs.writeFileSync('packages/agent-protocol/schema.json', JSON.stringify(schemas, null, 2) + '\n');
