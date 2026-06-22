"""Feature-permission keys for per-user feature gating.

Single source of truth for which feature keys exist. The frontend mirror in
``frontend/lib/feature-permissions.ts`` must stay name-for-name in sync.

Admins implicitly bypass every gate (see ``services.auth.ensure_feature``); only
viewer accounts are filtered by this set. The standalone ships a single feature —
the parent platform's other keys (master_list, investment_advisors, …) don't
exist here.
"""

from __future__ import annotations

EMAIL_EXTRACTOR = "email_extractor"

ALL_FEATURE_KEYS: frozenset[str] = frozenset({EMAIL_EXTRACTOR})
