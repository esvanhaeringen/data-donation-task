"""
Redaction of PII from text: emails, Dutch postal codes, and phone numbers.

All three patterns are applied in a single pass over the string, making this
efficient even for large inputs.
"""

import re

REDACT_EMAIL = "[EMAIL]"
REDACT_PHONE = "[PHONE]"
REDACT_POSTAL_CODE = "[POSTAL_CODE]"
# REDACT_ADDRESS = "[ADDRESS]"

# ---------------------------------------------------------------------------
# Individual pattern strings (used both in the combined re and standalone fns)
# ---------------------------------------------------------------------------

# Email addresses – RFC 5322 local part + domain, with some practical limits.
# Quantifiers are bounded to RFC limits (local part <= 64 octets, RFC 5321;
# DNS labels <= 63 chars, RFC 1035) instead of unbounded `+`. Unbounded
# quantifiers here are O(n) per starting position on non-matching runs (e.g.
# long digit/hash strings with no "@", or "a@" followed by a long run with no
# valid TLD), which is O(n^2) over the whole string. Bounding them caps the
# work per position to a constant, restoring linear-time scanning.
_EMAIL_PAT = r"[a-zA-Z0-9._%+\-]{1,64}@(?:[a-zA-Z0-9\-]{1,63}\.){1,20}[a-zA-Z]{2,24}"

# Dutch postal codes: 4 digits (no leading zero) + optional single space + 2 letters
_POSTAL_PAT = r"(?<!\d)[1-9][0-9]{3}[ ]?[A-Za-z]{2}(?!\w)"

# Phone numbers – possessive-style groups prevent catastrophic backtracking.
# Covers: +31 6 12345678 | 06-12345678 | (020) 1234567 | 0201234567 | +1-800-555-0100
_PHONE_PAT = (
    r"(?<![.\d])"
    r"(?:"
        # +31 followed by 9 digits, optional separators between groups
        r"\+31[-\s]?\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4}"
    r"|"
        # (020) 1234567 — parens area code then 6–7 digit subscriber number
        r"\(0\d{1,3}\)[-\s]?\d{6,7}"
    r"|"
        # 0xxxxxxxxx — bare 10 digits, no separators (06-bare, 020-bare, etc.)
        r"0\d{9}"
    r"|"
        # 0x(x)(x)-xxxxxxx(x) — one separator, area (1–3 extra digits) + 6–8 subscriber digits
        r"0\d{1,3}[-\s.]\d{6,8}"
    r")"
    r"(?![.\d])"
)

# Dutch addresses: Detects common street name suffixes in Dutch addresses, followed by an optional
# street number (1–5 digits) and optional letter/extension. 'Markt' and 'pad' are not included as 
# they are often used in non-address contexts (e.g. supermarkt, ipad). 
# _ADDRESS_PAT = r"([A-Z][a-z ]{1,64} )?[A-Za-z\-]*(weg|straat|laan|plein|dreef|singel|gracht|kade|boulevard|hof|park|dijk|steeg)\b([A-Za-z ]{0,64} [0-9]{1,5}[A-Za-z\-]{0,2})?"

# ---------------------------------------------------------------------------
# Single combined regex – one pass, named groups for dispatch
# ---------------------------------------------------------------------------

_COMBINED_RE = re.compile(
    rf"(?P<email>{_EMAIL_PAT})|(?P<postal>{_POSTAL_PAT})|(?P<phone>{_PHONE_PAT})",#|(?P<address>{_ADDRESS_PAT})",
    re.IGNORECASE,
)

_REPLACEMENTS: dict[str, str] = {
    "email": REDACT_EMAIL,
    "postal": REDACT_POSTAL_CODE,
    "phone": REDACT_PHONE,
    # "address": REDACT_ADDRESS,
}


def _replace(m: re.Match) -> str:  # type: ignore[type-arg]
    return _REPLACEMENTS[m.lastgroup]  # type: ignore[index]


def redact(text: str) -> str:
    """Redact emails, Dutch postal codes, and phone numbers from *text* in one pass."""
    return _COMBINED_RE.sub(_replace, text)


# ---------------------------------------------------------------------------
# Convenience single-type helpers (compile standalone patterns lazily)
# ---------------------------------------------------------------------------

_EMAIL_RE = re.compile(_EMAIL_PAT, re.IGNORECASE)
_POSTAL_RE = re.compile(_POSTAL_PAT, re.IGNORECASE)
_PHONE_RE = re.compile(_PHONE_PAT, re.IGNORECASE)


def redact_email(text: str) -> str:
    return _EMAIL_RE.sub(REDACT_EMAIL, text)


def redact_dutch_postal_code(text: str) -> str:
    return _POSTAL_RE.sub(REDACT_POSTAL_CODE, text)


def redact_phone(text: str) -> str:
    return _PHONE_RE.sub(REDACT_PHONE, text)


# def redact_address(text: str) -> str:
#     return _ADDRESS_PAT.sub(REDACT_ADDRESS, text)
