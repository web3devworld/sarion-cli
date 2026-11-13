import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const lock = JSON.parse(fs.readFileSync("package-lock.json"));
const meta = JSON.parse(fs.readFileSync("package.json"));
const components = Object.entries(lock.packages)
  .filter(([p]) => p)
  .map(([p, v]) => ({
    type: "library",
    name: p.split("node_modules/").at(-1),
    version: v.version,
    scope: v.dev ? "excluded" : "required",
    licenses: v.license ? [{ license: { name: v.license } }] : [],
    properties: [
      { name: "npm:integrity", value: v.integrity ?? "unknown" },
      { name: "sarion:lockPath", value: p },
    ],
  }));
fs.mkdirSync("artifacts", { recursive: true });
fs.writeFileSync(
  "artifacts/sbom.cdx.json",
  JSON.stringify(
    {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      version: 1,
      metadata: {
        component: {
          type: "application",
          name: meta.name,
          version: meta.version,
        },
      },
      components,
    },
    null,
    2,
  ) + "\n",
);
fs.writeFileSync(
  "artifacts/build-provenance.json",
  JSON.stringify(
    {
      version: 1,
      builder: "scripts/build.mjs + scripts/package.mjs",
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      lockSha256: createHash("sha256")
        .update(fs.readFileSync("package-lock.json"))
        .digest("hex"),
      sourceCommit:
        process.env.SARION_SOURCE_COMMIT ??
        execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      signature: "UNSIGNED; operator attestation required",
    },
    null,
    2,
  ) + "\n",
);
