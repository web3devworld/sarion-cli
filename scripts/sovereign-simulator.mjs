import http from "node:http";
import { pathToFileURL } from "node:url";
// Protocol/network qualification ONLY. This fixture supplies no inference and
// cannot establish enterprise identity, memory or on-premises qualification.
export async function sovereignSimulator() {
  const server = http.createServer((req, res) => {
    const url = "http://127.0.0.1:" + server.address().port;
    const reply = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (
      req.headers.authorization !==
      "Bearer simulator-only-not-a-real-credential"
    )
      return reply(401, { error: { code: "UNAUTHENTICATED" } });
    if (req.headers["cortex-agent-version"] !== "1.0")
      return reply(426, { error: { code: "PROTOCOL_UNSUPPORTED" } });
    const caps = {
      protocol: "1.0",
      boundary: {
        id: "simulator-private",
        kind: "sovereign",
        issuer: url,
        audience: url,
      },
      principal: {
        subject: "fixture-user",
        tenantId: "fixture-tenant",
        accountId: "fixture-account",
        scopes: ["agent.session.read"],
      },
      policyRevision: "simulator-v1",
      features: {
        durableTurns: true,
        localTools: false,
        durableReceipts: false,
        continuations: false,
        executionClaims: false,
        deltaReplay: false,
        memorySearch: false,
        projectBinding: false,
        usage: false,
      },
      limits: {
        requestBytes: 65536,
        contextBytes: 65536,
        eventBytes: 65536,
        toolArgsBytes: 65536,
        receiptBytes: 65536,
        maxTools: 0,
        maxOutputTokens: 0,
        maxSteps: 1,
      },
      models: [
        {
          id: "private-unprovisioned",
          label: "Private model (NOT provisioned)",
          eligible: false,
          text: true,
          tools: false,
          streaming: false,
          contextTokens: null,
          maxOutputTokens: 0,
          efforts: [],
          selection: "strict",
        },
      ],
      defaultModel: "private-unprovisioned",
      budgetUnit: null,
    };
    if (req.url === "/api/agent/v1/capabilities") return reply(200, caps);
    if (req.url === "/api/agent/v1/models")
      return reply(200, {
        models: caps.models,
        defaultModel: caps.defaultModel,
      });
    return reply(501, {
      error: {
        code: "CAPABILITY_MISSING",
        message: "Simulator has no inference or enterprise services",
      },
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: "http://127.0.0.1:" + server.address().port };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { url } = await sovereignSimulator();
  console.log(
    JSON.stringify({
      url,
      boundary: "sovereign",
      zeroEgress: true,
      credential: "simulator-only-not-a-real-credential",
      inference: "UNAVAILABLE; protocol fixture only",
    }),
  );
}
