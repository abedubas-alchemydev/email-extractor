"""Inline verification: syntax + MX presence.

Runs against every discovered email immediately on insert. SMTP RCPT is a
separate, user-triggered endpoint and lives in another module.

``email-validator``'s ``validate_email(check_deliverability=True)`` does both
the syntax parse and a DNS MX lookup. It's synchronous; we offload to a
worker thread so the aggregator's event loop isn't blocked on DNS.
"""

from __future__ import annotations

from anyio import to_thread
from email_validator import (
    EmailNotValidError,
    EmailSyntaxError,
    EmailUndeliverableError,
    validate_email,
)


async def check_syntax_and_mx(email: str) -> tuple[bool, bool, str | None]:
    """Return ``(syntax_valid, mx_present, error_message_or_None)``.

    Never raises. Categorises ``EmailSyntaxError`` as syntax failure (no MX
    lookup attempted), and ``EmailUndeliverableError`` as syntax-OK but MX
    missing. Anything else is treated as syntax failure with the error string.
    """

    def _validate() -> None:
        validate_email(email, check_deliverability=True)

    try:
        await to_thread.run_sync(_validate)
        return True, True, None
    except EmailSyntaxError as exc:
        return False, False, str(exc)
    except EmailUndeliverableError as exc:
        return True, False, str(exc)
    except EmailNotValidError as exc:
        # Catch-all for the parent type — defensive.
        return False, False, str(exc)
    except Exception as exc:  # noqa: BLE001
        return False, False, f"verification failed: {exc}"
