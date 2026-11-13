import fs from "node:fs";
import { validateNetwork } from "./network.ts";
import os from "node:os";
import { spawnSync } from "node:child_process";
let windowsSid: string | undefined;
import path from "node:path";
import { assert, Failure } from "../agent-protocol/validation.ts";
export interface Profile {
  projectBindings?: Record<string, string>;
  url: string;
  boundary: "cloud" | "sovereign";
  zeroEgress?: boolean;
  addresses?: string[];
  credentialExpiresAt?: number;
  boundaryId?: string;
  issuer?: string;
  audience?: string;
  principal?: { subject: string; tenantId: string; accountId: string };
}
export interface Config {
  version: 1;
  current: string;
  profiles: Record<string, Profile>;
  preferences: { model: string; verbosity: string };
}
export const home = (): string =>
  process.env.SARION_V2_HOME || path.join(os.homedir(), ".config", "sarion-v2");
export function privateDir(p: string): void {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(p);
  assert(st.isDirectory() && !st.isSymbolicLink(), "Unsafe state directory");
  if (process.platform === "win32") {
    if (!windowsSid) {
      const identity = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value",
        ],
        { encoding: "utf8" },
      );
      assert(
        identity.status === 0 && /^S-[0-9-]+$/.test(identity.stdout.trim()),
        "Cannot establish Windows state owner",
      );
      windowsSid = identity.stdout.trim();
    }
    const acl = spawnSync(
      "icacls.exe",
      [p, "/inheritance:r", "/grant:r", "*" + windowsSid + ":(OI)(CI)F"],
      {
        encoding: "utf8",
      },
    );
    assert(acl.status === 0, "Cannot enforce private Windows state ACL");
    const check = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        '$p=[Console]::In.ReadToEnd(); $a=Get-Acl -LiteralPath $p; $u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; foreach($r in $a.Access){$s=$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; if($r.AccessControlType -eq \"Allow\" -and $s -ne $u -and $s -ne \"S-1-5-18\"){exit 1}}',
      ],
      { input: p, encoding: "utf8", timeout: 10000 },
    );
    assert(
      check.status === 0,
      "State directory has foreign Windows grants; remove them before use",
    );
  }
  if (process.platform !== "win32") {
    assert(
      st.uid === process.getuid?.(),
      "State directory belongs to another user",
    );
    assert((st.mode & 0o077) === 0, "State directory must be mode 0700");
  }
}
export function atomic(p: string, data: string): void {
  privateDir(path.dirname(p));
  const tmp = p + "." + process.pid + ".tmp";
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
  if (process.platform !== "win32") {
    const d = fs.openSync(path.dirname(p), "r");
    try {
      fs.fsyncSync(d);
    } finally {
      fs.closeSync(d);
    }
  }
}
export function endpoint(url: string, development = false): string {
  const u = new URL(url);
  assert(
    !u.username && !u.password && !u.search && !u.hash,
    "Endpoint must not contain credentials, query or fragment",
  );
  assert(
    u.protocol === "https:" ||
      (development &&
        u.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname)),
    "HTTPS required (loopback fixtures require --development)",
  );
  return u.toString().replace(/\/$/, "");
}
export function loadConfig(): Config {
  const p = path.join(home(), "config.json");
  if (!fs.existsSync(p))
    return {
      version: 1,
      current: "cloud",
      profiles: {
        cloud: { url: "https://sarion.volta.quest", boundary: "cloud" },
      },
      preferences: { model: "auto", verbosity: "normal" },
    };
  const st = fs.lstatSync(p);
  assert(st.isFile() && !st.isSymbolicLink(), "Unsafe configuration file");
  const c = JSON.parse(fs.readFileSync(p, "utf8")) as Config;
  assert(c.version === 1 && c.profiles?.[c.current], "Invalid configuration");
  return c;
}
export const saveConfig = (c: Config): void =>
  atomic(path.join(home(), "config.json"), JSON.stringify(c, null, 2) + "\n");
export function profile(c: Config, name = c.current): Profile {
  const p = c.profiles[name];
  if (!p) throw new Failure("PROFILE_UNKNOWN", "Unknown profile " + name, 2);
  endpoint(p.url, true);
  validateNetwork(p);
  return p;
}
