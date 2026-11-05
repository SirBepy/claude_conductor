// "Add a project from GitHub", inline in the picker's empty-results state
// (mockup approved 2026-11-05). A third action beside Create/Browse: search the
// dev's own repos (every signed-in gh login plus its orgs), widen to all public
// repos on request, then clone the pick into the projects root and resolve the
// picker with the new folder - the same hand-off Create makes.
//
// The work happens in the daemon (`github_search_repos` / `github_clone_repo`,
// daemon/methods/github_repos.rs) so the phone runs the identical flow with the
// clone on the PC. This file owns only the flow state and its rows;
// add-project.ts is the one caller and project-picker.ts feeds it keystrokes.

import { html, type TemplateResult } from "lit-html";
import { invoke } from "../../../shared/ipc";
import type { AddProjectDeps, AddProjectState } from "./add-project";

export interface RepoHit {
  full_name: string;
  description: string;
  private: boolean;
  /** The gh login that can see it; empty for a public-search hit. */
  account: string;
  stars: number | null;
  /** Existing checkout of this repo, if any: picking it opens that folder. */
  on_disk: string | null;
}

export type GithubMode =
  | "idle"
  | "searching"
  | "mine"
  | "public-searching"
  | "public"
  | "cloning"
  | "noauth"
  | "missing"
  | "none"
  | "error";

export interface GithubFlow {
  mode: GithubMode;
  hits: RepoHit[];
  selected: number;
  /** Identifies the live search/clone: a slow reply to an abandoned one
   *  carries an older value and is dropped instead of repainting. */
  token: number;
  repo: RepoHit | null;
  error: string;
  failedAccounts: number;
}

interface SearchReply {
  status: "ok" | "not_signed_in" | "gh_missing";
  items: RepoHit[];
  failed_accounts: number;
}

export function newGithubFlow(): GithubFlow {
  return { mode: "idle", hits: [], selected: 0, token: 0, repo: null, error: "", failedAccounts: 0 };
}

/** Back to the three actions. Called whenever the typed term changes, since a
 *  result list for "hub" is not an answer for "hubb". */
export function resetGithub(flow: GithubFlow): void {
  flow.token++;
  flow.mode = "idle";
  flow.hits = [];
  flow.selected = 0;
  flow.repo = null;
  flow.error = "";
  flow.failedAccounts = 0;
}

/** Whether the typed term is worth a GitHub search: a folder-style name, or an
 *  `owner/repo` pair (which `isValidProjectName` rightly refuses as a folder). */
export function isSearchableTerm(typed: string): boolean {
  return /^[A-Za-z0-9][\w.-]*(\/[\w.-]+)?$/.test(typed) && typed.length <= 100;
}

const repoName = (h: RepoHit): string => h.full_name.split("/")[1] ?? h.full_name;

async function runSearch(
  typed: string,
  scope: "mine" | "public",
  flow: GithubFlow,
  deps: AddProjectDeps,
): Promise<void> {
  const token = ++flow.token;
  flow.mode = scope === "mine" ? "searching" : "public-searching";
  flow.selected = 0;
  deps.renderModal();
  let reply: SearchReply;
  try {
    reply = await invoke<SearchReply>("github_search_repos", { query: typed, scope });
  } catch (e) {
    if (token !== flow.token) return;
    flow.mode = "error";
    flow.error = String(e);
    deps.renderModal();
    return;
  }
  if (token !== flow.token) return;
  if (reply.status === "gh_missing") flow.mode = "missing";
  else if (reply.status === "not_signed_in") flow.mode = "noauth";
  else {
    flow.hits = reply.items;
    flow.failedAccounts = reply.failed_accounts;
    if (reply.items.length > 0) flow.mode = scope;
    // Nothing of the dev's own matched: the next question is always "then is
    // it public?", so answer it now instead of asking for another click.
    else if (scope === "mine") return runSearch(typed, "public", flow, deps);
    else flow.mode = "none";
  }
  deps.renderModal();
}

export function searchGithub(typed: string, flow: GithubFlow, deps: AddProjectDeps): Promise<void> {
  return runSearch(typed, "mine", flow, deps);
}

export function searchPublic(typed: string, flow: GithubFlow, deps: AddProjectDeps): Promise<void> {
  return runSearch(typed, "public", flow, deps);
}

export async function cloneRepo(hit: RepoHit, flow: GithubFlow, deps: AddProjectDeps): Promise<void> {
  const token = ++flow.token;
  flow.mode = "cloning";
  flow.repo = hit;
  deps.renderModal();
  try {
    const res = await invoke<{ path: string; name: string }>("github_clone_repo", {
      fullName: hit.full_name,
      account: hit.account,
    });
    if (token !== flow.token) return;
    deps.finish({ path: res.path, name: res.name, machineId: null });
  } catch (e) {
    if (token !== flow.token) return;
    flow.mode = "error";
    flow.error = String(e);
    deps.renderModal();
  }
}

/** Keys while the GitHub panel is up. Returns true when the key was consumed.
 *  `noLocalRows` gates the entry key: Enter only starts a search when the list
 *  has nothing for it to pick, so it never competes with picking a project. */
export function handleGithubKey(
  e: KeyboardEvent,
  typed: string,
  noLocalRows: boolean,
  state: AddProjectState,
  deps: AddProjectDeps,
): boolean {
  const flow = state.github;
  if (flow.mode === "idle") {
    if (e.key === "Enter" && noLocalRows && isSearchableTerm(typed)) {
      e.preventDefault();
      void searchGithub(typed, flow, deps);
      return true;
    }
    return false;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    resetGithub(flow);
    deps.renderModal();
    return true;
  }
  if (flow.mode !== "mine" && flow.mode !== "public") return false;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const step = e.key === "ArrowDown" ? 1 : -1;
    flow.selected = Math.max(0, Math.min(flow.selected + step, flow.hits.length - 1));
    deps.renderModal();
    return true;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    const hit = flow.hits[Math.min(flow.selected, flow.hits.length - 1)];
    if (hit) void cloneRepo(hit, flow, deps);
    return true;
  }
  return false;
}

/** The third action row, beside Create and Browse. */
export function renderGithubRow(typed: string, state: AddProjectState, deps: AddProjectDeps): TemplateResult {
  const go = (): void => { void searchGithub(typed, state.github, deps); };
  return html`
    <div class="pp-act pp-act-github" role="button" tabindex="0"
      @click=${go}
      @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } }}
    >
      <i class="ph ph-github-logo pp-lead"></i>
      <span class="pp-body"><b>Search GitHub for "${typed}"</b><br><em>your repos first, then all public</em></span>
      <span class="pp-kbd">Enter</span>
    </div>`;
}

function renderHit(h: RepoHit, i: number, flow: GithubFlow, deps: AddProjectDeps): TemplateResult {
  return html`
    <li class="project-picker-row ${i === flow.selected ? "selected" : ""}" data-gh-row=${h.full_name}
      @mouseenter=${() => { if (flow.selected !== i) { flow.selected = i; deps.renderModal(); } }}
      @click=${() => void cloneRepo(h, flow, deps)}>
      <div class="project-picker-avatar"><i class="ph ${h.private ? "ph-lock-simple" : "ph-github-logo"} pp-gh-av"></i></div>
      <div class="project-picker-info">
        <span class="project-picker-name">${h.full_name}</span>
        <span class="pp-gh-desc">${h.description}</span>
      </div>
      <span class="pp-gh-meta">
        ${h.on_disk ? html`<span class="pp-gh-chip pp-gh-chip--disk" title=${h.on_disk}><i class="ph ph-check"></i> on disk</span>` : ""}
        ${h.stars ? html`<span class="pp-gh-chip"><i class="ph ph-star"></i> ${h.stars.toLocaleString()}</span>` : ""}
        ${h.account ? html`<span class="pp-gh-chip">${h.account}</span>` : ""}
      </span>
    </li>`;
}

const sectionHead = (icon: string, label: string, n: string): TemplateResult =>
  html`<li class="pp-gh-sec"><i class="ph ${icon}"></i> ${label} <span class="pp-gh-n">${n}</span></li>`;

/** Everything the list area shows once a GitHub search has been started. */
export function renderGithubPanel(typed: string, state: AddProjectState, deps: AddProjectDeps): TemplateResult {
  const flow = state.github;
  const back = html`<li class="pp-gh-back"><button @click=${() => { resetGithub(flow); deps.renderModal(); }}>
    <i class="ph ph-arrow-left"></i> Back to "${typed}" actions</button></li>`;
  const stateLine = (icon: string, body: TemplateResult, link?: TemplateResult): TemplateResult =>
    html`${back}<li class="pp-gh-state"><i class="ph ${icon} pp-gh-big"></i><span>${body}</span>${link ?? ""}</li>`;

  switch (flow.mode) {
    case "searching":
      return stateLine("ph-circle-notch pp-gh-spin", html`Searching <b>your repos</b> for "${typed}"&hellip;`);
    case "public-searching":
      return stateLine("ph-circle-notch pp-gh-spin", html`Searching <b>all of GitHub</b> for "${typed}"&hellip;`);
    case "mine":
      return html`${back}
        ${sectionHead("ph-user", "Your repos", String(flow.hits.length))}
        ${flow.hits.map((h, i) => renderHit(h, i, flow, deps))}
        ${flow.failedAccounts > 0
          ? html`<li class="pp-gh-warn">${flow.failedAccounts} signed-in GitHub account${flow.failedAccounts > 1 ? "s" : ""} could not be read, so some repos may be missing.</li>`
          : ""}
        <li class="pp-gh-more"><div class="pp-act" role="button" tabindex="0"
          @click=${() => void searchPublic(typed, flow, deps)}
          @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void searchPublic(typed, flow, deps); } }}>
          <i class="ph ph-globe pp-lead"></i>
          <span class="pp-body"><b>Search all of GitHub for "${typed}"</b><br><em>public repos from anyone</em></span>
        </div></li>`;
    case "public":
      return html`${back}
        ${sectionHead("ph-globe", "Public on GitHub", String(flow.hits.length))}
        ${flow.hits.map((h, i) => renderHit(h, i, flow, deps))}`;
    case "cloning": {
      const r = flow.repo;
      if (!r) return html``;
      return html`<li class="pp-gh-state"><i class="ph ph-git-branch pp-gh-big"></i>
        <span>${r.on_disk ? "Opening" : "Cloning"} <b>${r.full_name}</b></span>
        ${r.on_disk ? html`<span class="pp-gh-sub">${r.on_disk}</span>` : html`<div class="pp-gh-bar"><i></i></div><span class="pp-gh-sub">into the projects root as ${repoName(r)}</span>`}
      </li>`;
    }
    case "noauth":
      return stateLine("ph-plugs", html`<b>GitHub isn't signed in on this PC</b>`,
        html`<span>Run <code>gh auth login</code> in a terminal, then search again.</span>
          <button class="pp-gh-link" @click=${() => void searchGithub(typed, flow, deps)}>Search again</button>`);
    case "missing":
      return stateLine("ph-plugs", html`<b>The GitHub CLI isn't installed on this PC</b>`,
        html`<span>Install <code>gh</code> from cli.github.com, sign in, then search again.</span>
          <button class="pp-gh-link" @click=${() => void searchGithub(typed, flow, deps)}>Search again</button>`);
    case "none":
      return stateLine("ph-magnifying-glass", html`No repo called <b>"${typed}"</b> on GitHub`,
        html`<button class="pp-gh-link" @click=${() => { resetGithub(flow); deps.renderModal(); }}>Create it locally instead</button>`);
    case "error":
      return stateLine("ph-warning", html`<b>GitHub didn't answer</b>`,
        html`<span class="pp-gh-sub">${flow.error}</span>
          <button class="pp-gh-link" @click=${() => (flow.repo ? void cloneRepo(flow.repo, flow, deps) : void searchGithub(typed, flow, deps))}>Try again</button>`);
    default:
      return html``;
  }
}
