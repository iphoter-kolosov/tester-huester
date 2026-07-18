// PII / secret redaction, done in the browser BEFORE anything leaves the page. This is the "mask by
// default" wedge: LogRocket/FullStory-class tools got sued for wiretapping because they shipped raw text.
// We never send a password value or an Authorization header off the page.

const SENSITIVE_NAME = /pass|secret|token|otp|cvv|cvc|cc-|card|iban|ssn|social|\bpin\b|auth|api[-_]?key/i
const SENSITIVE_HEADER = /^(authorization|cookie|set-cookie|x-api-key|x-auth-token|proxy-authorization)$/i
const TOKEN_LIKE = /\b(eyJ[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{10,})\b/g

export const MASK = '••••••'

export function isSensitiveField(el: Element): boolean {
  const type = ((el as HTMLInputElement).type || '').toLowerCase()
  if (type === 'password') return true
  const hay = [el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('autocomplete'), el.getAttribute('aria-label')]
    .filter(Boolean)
    .join(' ')
  return SENSITIVE_NAME.test(hay)
}

// Value of a form field, masked if the field looks sensitive, otherwise length-capped.
export function maskInputValue(el: Element, value: string): string {
  if (isSensitiveField(el)) return MASK
  return capText(scrubTokens(value), 200)
}

// Replace obvious credential-shaped substrings anywhere in free text (console lines, URLs, bodies).
export function scrubTokens(s: string): string {
  return s.replace(TOKEN_LIKE, MASK)
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADER.test(k) ? MASK : scrubTokens(v)
  }
  return out
}

// Query strings routinely carry tokens/emails; strip values of sensitive-looking params, keep shape.
export function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    for (const key of Array.from(u.searchParams.keys())) {
      if (SENSITIVE_NAME.test(key) || /email|e-mail|user/i.test(key)) u.searchParams.set(key, MASK)
    }
    return scrubTokens(u.toString())
  } catch {
    return scrubTokens(url)
  }
}

export function capText(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}
