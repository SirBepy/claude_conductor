# API-credit account balance and cap gate

Read before editing `daemon/api_credit.rs`, `accounts/api_credit.rs` or the `API_CREDIT_BLOCKED` gate.

- **API-credit balance needs a Console login, not the claude.ai one.** `daemon/api_credit.rs` polls `platform.claude.com` `/api/organizations/{console_org}/prepaid/credits`, `/spend_limits` and `/current_spend` with the platform.claude.com `sessionKey` (`console-session-<id>.txt`).
  - The claude.ai cookie gets 403 on the Console org, and the Console cookie gets 403 on the Max org (verified live 2026-10-26).
  - `limit_usd` is in cents despite its name.
  - Spending the Max credit counts against the Console spend limit.
  - The cap gate refuses new turns with `API_CREDIT_BLOCKED` (-32007, HTTP 402 on the REST send) when the `subscription_api_credit` tranche hits $0, spend reaches the limit, or a successful credits read shows purchased credit but no Max grant this cycle (purchased credit is never drained by this account kind). Unknown figures never create a block; a non-auth fetch error only keeps a block that was already known.
