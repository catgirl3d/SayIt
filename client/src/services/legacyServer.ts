// The upstream author's former trial server. This fork does not run or control it,
// so no feature may contact it: announcements from it would be untrusted, and this
// domain must never be saved as a backend address.
const LEGACY_TRIAL_SERVER_HOST = 'sayitapp.site'

// The absolute parser is tried first: same-scheme forms without "//", such as
// "https:sayitapp.site", resolve to a relative path when parsed against a base URL, while
// the absolute parser treats them as a host. The fixed base is only a fallback for forms
// the absolute parser rejects, such as "//sayitapp.site"; its placeholder host keeps bare
// hosts and ordinary text from matching the legacy domain.
function parseHostname(url: string): string | null {
  try {
    return new URL(url).hostname
  } catch {
    try {
      return new URL(url, 'https://placeholder.invalid/').hostname
    } catch {
      return null
    }
  }
}

/** Whether a URL points at the former trial server host or one of its subdomains. */
export function isLegacyTrialServerUrl(url: string): boolean {
  const hostname = parseHostname(url)?.toLowerCase().replace(/\.+$/, '')
  if (!hostname) return false
  return hostname === LEGACY_TRIAL_SERVER_HOST || hostname.endsWith(`.${LEGACY_TRIAL_SERVER_HOST}`)
}
