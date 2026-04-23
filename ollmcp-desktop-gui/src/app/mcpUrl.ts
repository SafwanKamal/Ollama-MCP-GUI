/**
 * Build the MCP HTTP URL sent to the backend.
 * If the base URL ends with `?token=` or `&token=` (empty value), append the keychain token (Zapier-style).
 * Otherwise use the base URL as-is (full URL including any embedded secret).
 */
export function mcpBaseNeedsAppendedToken(base: string): boolean {
  return /[?&]token=$/i.test(base.trim())
}

export function buildMcpServerUrl(base: string, token: string | null | undefined): string {
  const b = base.trim()
  if (!b) return ''
  const t = token?.trim()
  if (t && mcpBaseNeedsAppendedToken(b)) {
    return `${b}${encodeURIComponent(t)}`
  }
  return b
}
