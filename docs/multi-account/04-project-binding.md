# Milestone 04 - Project binding, default account, new-chat picker

Depends on: 01 (accounts), 02 (routing consumes the resolved account). See `00-overview.md`.

## Goal
Bind an account to a project, resolve the account for a new chat (binding -> default), and let the
user pick it via always-visible chips in the existing new-chat modal.

## Context
- `ProjectConfig` (`types/project.rs:46-61`) already holds `automation: Option<AutomationConfig>`;
  mirror that for the new field. Path-casing dedupe carries `avatar`/`automation`
  (`settings/identity.rs:69-101`) - add the new field there too.
- Automation subview (`views/project-detail/subviews/automation/automation.ts`) already renders
  `.option` toggle rows + a select, saved via `api.updateProject(id, patch)`.
- New-chat modal `views/sessions/model-effort-modal.ts` (`.me-columns` -> `.me-left-col`), invoked
  from `project-detail.ts:184`, `active-session.ts:176`, `pending-flow.ts:128`, `clear.ts:24`.
- `defaultAccountId` (Settings, from 01).

## Approach
1. Add `ProjectConfig.preferred_account_id: Option<String>` (`#[serde(default)]`), carry-forward in
   `dedupe_projects_by_path_key`, ts-rs export.
2. Automation subview: new "Claude account" row (account icon + name select) saved via
   `updateProject`.
3. Account-detail view: a reverse "projects using this account" list (query ProjectConfigs by
   `preferred_account_id`), add/remove from there.
4. New-chat modal: all registered accounts render as chips, always visible (no collapsed trigger).
   Initial selection = project binding else `defaultAccountId` else, with exactly one account
   registered, that account, else unselected (`resolveInitialAccountId` in
   `account-picker-logic.ts`). Picking a chip and clicking Start writes the binding
   unconditionally, no confirmation step. Thread the chosen `account_id` into the session start
   (feeds 02).

## Files
- `src-tauri/src/types/project.rs`, `src-tauri/src/settings/identity.rs`
- `views/project-detail/subviews/automation/*`, an account-detail view
- `views/sessions/model-effort-modal.ts`, the IPC start-session params, `export_types.rs`

## Acceptance
- A bound project auto-selects its account on new chat; unbound falls back to the default.
- Starting a session with a different chip picked writes the binding; it survives a path-casing merge.
- The account view lists and edits that account's projects.
