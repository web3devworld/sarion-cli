import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import type { Profile } from "./config.ts";
import { assert } from "../agent-protocol/validation.ts";

export function privateAddress(address: string): boolean {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  return (
    net.isIP(address) === 6 && (address === "::1" || /^(fc|fd)/i.test(address))
  );
}
export function validateNetwork(p: Profile): void {
  if (!p.zeroEgress) return;
  assert(
    p.boundary === "sovereign",
    "Zero-egress requires a sovereign profile",
    "POLICY_DENIED",
    4,
  );
  const host = new URL(p.url).hostname.replace(/^\[|\]$/g, "");
  const addresses = p.addresses ?? (net.isIP(host) ? [host] : []);
  assert(
    addresses.length > 0 &&
      addresses.length <= 8 &&
      addresses.every(privateAddress),
    "Zero-egress requires explicit private IP addresses; DNS, public and link-local destinations are denied",
    "POLICY_DENIED",
    4,
  );
  assert(
    !net.isIP(host) || addresses.every((a) => a === host),
    "Literal endpoint and pinned address differ",
    "POLICY_DENIED",
    4,
  );
}
/** Every CLI network request, including login, passes this gate. Private mode
 * uses explicit addresses without DNS, proxies, redirects or public fallback.
 * TLS still validates the configured hostname and normal OS trust store.
 */
export async function endpointFetch(
  p: Profile,
  url: string | URL | Request,
  init: RequestInit = {},
  transport: typeof fetch = fetch,
): Promise<Response> {
  validateNetwork(p);
  const target = new URL(String(url)),
    base = new URL(p.url);
  assert(
    target.origin === base.origin &&
      target.pathname.startsWith(base.pathname.replace(/\/$/, "") + "/"),
    "Request outside selected endpoint",
    "POLICY_DENIED",
    4,
  );
  assert(
    !target.username && !target.password,
    "URL credentials denied",
    "POLICY_DENIED",
    4,
  );
  if (!p.zeroEgress)
    return transport(target.toString(), { ...init, redirect: "error" });
  const host = base.hostname.replace(/^\[|\]$/g, "");
  const address = (p.addresses ?? [host])[0];
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  assert(!("host" in headers), "Host override denied", "POLICY_DENIED", 4);
  return new Promise((resolve, reject) => {
    const request = (target.protocol === "https:" ? https : http).request(
      target,
      {
        method: init.method ?? "GET",
        headers,
        agent: false,
        signal: init.signal ?? undefined,
        lookup: ((_hostname: string, options: any, cb: any) =>
          options?.all
            ? cb(null, [{ address, family: net.isIP(address) }])
            : cb(null, address, net.isIP(address))) as any,
      },
      (response) => {
        if (response.statusCode! >= 300 && response.statusCode! < 400) {
          response.destroy();
          reject(new Error("Endpoint redirect denied"));
          return;
        }
        const h = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (value !== undefined)
            h.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
        resolve(
          new Response(
            [204, 205, 304].includes(response.statusCode!)
              ? null
              : (Readable.toWeb(response) as ReadableStream<Uint8Array>),
            { status: response.statusCode, headers: h },
          ),
        );
      },
    );
    request.on("error", reject);
    if (init.body !== undefined && init.body !== null) {
      assert(
        typeof init.body === "string",
        "Only JSON request bodies supported",
      );
      request.end(init.body);
    } else request.end();
  });
}
