/**
 * The two different meanings of "host" in this app, kept apart.
 *
 * A *bind* host is what `vllm serve --host` receives and what the UI reports:
 * the address the engine listens on. A *connect* host is what this app dials to
 * reach that engine. They are usually the same string, but not always — a
 * wildcard bind means "every interface", which is not an address you can open a
 * socket to. Conflating the two is how a server bound to `0.0.0.0` ends up
 * described as living on `127.0.0.1`.
 *
 * Pure and dependency-free, like `argv.ts`, so the client components that render
 * an endpoint can share exactly the logic the supervisor probes with.
 */

/** Binds that mean "every interface" rather than one address. */
const WILDCARD_V4 = new Set(["0.0.0.0", ""]);
const WILDCARD_V6 = new Set(["::", "[::]", "::0", "[::0]"]);

/**
 * The address to dial for a server bound to `bindHost`.
 *
 * Wildcards collapse to the matching loopback — reachable, and it keeps the
 * app's own health traffic off the network. Anything else is dialled as given.
 */
export function connectHost(bindHost: string): string {
  const h = bindHost.trim();
  if (WILDCARD_V4.has(h)) return "127.0.0.1";
  if (WILDCARD_V6.has(h)) return "[::1]";
  return bracketIpv6(h);
}

/** The base URL of a server bound to `bindHost`, ready to have a path appended. */
export function baseUrl(bindHost: string, port: number): string {
  return `http://${connectHost(bindHost)}:${port}`;
}

/**
 * Whether a bind address keeps the server off the network.
 *
 * Drives the exposure warning in Settings, so it must recognise every spelling
 * of loopback — `localhost` and `127.0.0.2` are as private as `127.0.0.1`.
 */
export function isLoopback(bindHost: string): boolean {
  const h = stripBrackets(bindHost.trim().toLowerCase());
  if (h === "localhost" || h === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** A bare IPv6 literal needs brackets before it can go in a URL authority. */
function bracketIpv6(host: string): string {
  if (host.startsWith("[")) return host;
  return host.includes(":") ? `[${host}]` : host;
}

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}
