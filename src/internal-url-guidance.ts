// Guidance for the two Paperclip URL knobs the Telegram worker uses.
//
// - paperclipBaseUrl: the *internal* API URL the worker calls directly for
//   board actions (approvals, comments). fetchPaperclipApi only bypasses
//   ctx.http (and therefore Cloudflare Access) for loopback hosts, so a
//   public/Access-protected hostname here makes the plugin -> board API leg
//   return a 302/403 login challenge and approval buttons silently fail.
// - paperclipPublicUrl: the *public* hostname embedded in Telegram links for
//   humans. This one is meant to be the Access-protected address.
//
// See ODIAA-732 for the full analysis. This module is the zero-secret "Fix B":
// it nudges co-located deployments toward an internal base URL. Operators who
// genuinely must reach Paperclip over the public hostname should configure a
// Cloudflare Access service token instead (Fix A).

export type InternalUrlGuidance = {
  level: "warn";
  message: string;
};

type ParsedHost = {
  host: string; // hostname[:port], lowercased
  hostname: string; // hostname only, lowercased, brackets stripped for IPv6
};

function parseHost(raw: unknown): ParsedHost | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Accept values with or without a scheme. "localhost:3100" (no //) would be
  // misparsed as scheme "localhost:", so we only trust a parse that yields an
  // http(s) protocol and a real hostname.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const candidates = hasScheme ? [trimmed] : [trimmed, `https://${trimmed}`];

  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      if (!url.hostname) continue;
      return {
        host: url.host.toLowerCase(),
        hostname: url.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
      };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// Hosts the worker reaches directly without crossing Cloudflare Access: loopback,
// RFC1918 / link-local / unique-local addresses, internal DNS suffixes, and
// single-label service names (e.g. "paperclip", a docker-compose service host).
function isInternalHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0") {
    return true;
  }
  if (hostname === "::1") return true;
  // RFC1918 IPv4 private ranges
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  // link-local IPv4
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  // unique-local IPv6 (fc00::/7)
  if (/^f[cd][0-9a-f]{0,2}:/.test(hostname)) return true;
  // internal DNS suffixes
  if (
    hostname.endsWith(".internal") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".localhost")
  ) {
    return true;
  }
  // single-label hostname (no dot, not an IPv6 literal) -> internal service name
  if (!hostname.includes(".") && !hostname.includes(":")) return true;
  return false;
}

// Returns a non-blocking warning when paperclipBaseUrl points at a public
// hostname (the Cloudflare Access failure mode), otherwise null. Intentionally
// advisory: remote workers using a Cloudflare Access service token (Fix A)
// legitimately set a public base URL, so we warn rather than block.
export function evaluateInternalUrlGuidance(
  paperclipBaseUrl: unknown,
  paperclipPublicUrl: unknown,
): InternalUrlGuidance | null {
  const base = parseHost(paperclipBaseUrl);
  if (!base) return null; // empty/unparseable: default is loopback, nothing to warn about
  if (isInternalHostname(base.hostname)) return null;

  const pub = parseHost(paperclipPublicUrl);
  const matchesPublic = pub !== null && pub.host === base.host;

  const detail = matchesPublic
    ? "It matches your public URL, so it is almost certainly the Cloudflare Access–protected hostname."
    : "It looks like a public hostname rather than an internal address.";

  return {
    level: "warn",
    message:
      `Paperclip API URL "${base.host}" is not an internal/loopback address. ${detail} ` +
      "Behind Cloudflare Access this address returns a login challenge instead of the API, so approval buttons and /approve can silently fail. " +
      "Point it at an address the worker reaches directly (e.g. http://localhost:3100) and keep the public hostname in Paperclip public URL for human links. " +
      "If the worker can only reach Paperclip over the public hostname, configure a Cloudflare Access service token instead.",
  };
}
