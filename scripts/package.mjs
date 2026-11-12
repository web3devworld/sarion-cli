import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, sign, createPrivateKey } from "node:crypto";
const root = process.cwd(),
  stage = path.join(root, "artifacts", "stage");
fs.mkdirSync("artifacts", { recursive: true });
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage);
const meta = JSON.parse(fs.readFileSync("package.json", "utf8"));
for (const dir of ["bin", "dist", "LICENSES"])
  fs.cpSync(dir, path.join(stage, dir), { recursive: true });
fs.copyFileSync("README.md", path.join(stage, "README.md"));
const release = {
  ...meta,
  dependencies: {},
  devDependencies: {},
  scripts: {},
  files: ["bin", "dist", "README.md", "LICENSES"],
};
fs.writeFileSync(
  path.join(stage, "package.json"),
  JSON.stringify(release, null, 2) + "\n",
);
const result = JSON.parse(
  execFileSync(
    process.env.npm_execpath ? process.execPath : "npm",
    process.env.npm_execpath
      ? [
          process.env.npm_execpath,
          "pack",
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          path.join(root, "artifacts"),
        ]
      : [
          "pack",
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          path.join(root, "artifacts"),
        ],
    { cwd: stage, encoding: "utf8" },
  ),
);
const packed = Array.isArray(result) ? result[0] : Object.values(result)[0];
const file = path.join(root, "artifacts", packed.filename),
  data = fs.readFileSync(file);
const manifest = {
  version: meta.version,
  protocol: "1.0",
  file: packed.filename,
  sha256: createHash("sha256").update(data).digest("hex"),
  bytes: data.length,
  node: "24",
};
fs.writeFileSync(
  "artifacts/manifest.json",
  JSON.stringify(manifest, null, 2) + "\n",
);
fs.rmSync("artifacts/manifest.sig", { force: true });
if (process.env.SARION_SIGNING_KEY_FILE) {
  const key = createPrivateKey(
    fs.readFileSync(process.env.SARION_SIGNING_KEY_FILE),
  );
  fs.writeFileSync(
    "artifacts/manifest.sig",
    sign(null, fs.readFileSync("artifacts/manifest.json"), key).toString(
      "base64",
    ),
  );
}
console.log(
  file +
    " (signature " +
    (process.env.SARION_SIGNING_KEY_FILE
      ? "created"
      : "NOT CREATED — required for release") +
    ")",
);
