import { html, nothing, render } from "lit-html";
import { api } from "../../../../shared/api";
import { showToast } from "../../../../shared/toast";
import type { ProjectMcpServer } from "../../../../types/ipc.generated";
import type { ProjectCfg } from "./project-cfg";

/** The project's own MCP servers (a local app's HTTP `/mcp`, or a stdio program
 *  such as Roblox Studio's `mcp.bat`): a list with a sign-in button per HTTP row and an add form. Takes effect on the next turn's
 *  spawn, where the daemon probes each server before writing it in. */

const POLL_MS = 1500;
const POLL_FOR_MS = 120_000;

/** Same rule as the daemon (`project_mcp::check`): the name becomes the tool prefix. */
export function validMcpName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name) && name !== "cc_conductor";
}

export function validMcpUrl(url: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** What the add form's one field means: an http(s) URL, or a command line
 *  (program then arguments, double quotes keep a path with spaces together).
 *  `null` is a URL-looking value that is not http(s), or an empty command. */
export function parseMcpTarget(text: string): { url: string; command: string; args: string[] } | null {
  const t = text.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return validMcpUrl(t) ? { url: t, command: "", args: [] } : null;
  const parts: string[] = [];
  for (const m of t.matchAll(/"([^"]*)"|(\S+)/g)) parts.push(m[1] ?? m[2] ?? "");
  const [command, ...args] = parts;
  return command ? { url: "", command, args } : null;
}

/** One line for a listed server: its URL, or its command line. */
export function mcpTargetText(s: ProjectMcpServer): string {
  return s.url || [s.command, ...s.args].map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(" ");
}

async function currentServers(cwd: string): Promise<{ id: string | null; servers: ProjectMcpServer[] }> {
  const projects = (await api.listProjects()) as unknown as ProjectCfg[];
  const proj = projects.find((p) => p.path === cwd);
  return { id: proj?.id ?? null, servers: proj?.mcp_servers ?? [] };
}

async function save(cwd: string, next: ProjectMcpServer[]): Promise<void> {
  const { id } = await currentServers(cwd);
  const projectId = id ?? (await api.ensureProject(cwd)).id;
  await api.updateProject(projectId, { mcp_servers: next });
}

export async function renderMcpServersRow(cwd: string): Promise<void> {
  const root = document.getElementById("mcpServersControl");
  if (!cwd || !root) return;
  const { servers } = await currentServers(cwd);
  const httpUrls = servers.filter((s) => s.url).map((s) => s.url);
  const signed: Record<string, boolean> = httpUrls.length
    ? await api.mcpSignedIn(httpUrls).catch(() => ({}))
    : {};
  const redraw = () => renderMcpServersRow(cwd);

  const signIn = async (s: ProjectMcpServer) => {
    try {
      const { auth_url } = await api.mcpSignIn(s.url);
      await api.openExternal(auth_url);
      showToast(`Finish signing in to ${s.name} in the browser.`);
      const until = Date.now() + POLL_FOR_MS;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if ((await api.mcpSignedIn([s.url]))[s.url]) {
          showToast(`Signed in to ${s.name}.`);
          break;
        }
      }
    } catch (e) {
      console.error("[project-settings] mcp sign-in failed", e);
      showToast(`Could not start sign-in: ${e}`);
    }
    await redraw();
  };

  const remove = async (s: ProjectMcpServer) => {
    try {
      await save(cwd, servers.filter((x) => x.name !== s.name));
      showToast(`Removed ${s.name}.`);
    } catch (e) {
      console.error("[project-settings] mcp remove failed", e);
      showToast(`Could not remove ${s.name}: ${e}`);
    }
    await redraw();
  };

  const add = async () => {
    const name = (root.querySelector<HTMLInputElement>("#mcpNewName")?.value ?? "").trim();
    const target = parseMcpTarget(root.querySelector<HTMLInputElement>("#mcpNewUrl")?.value ?? "");
    if (!validMcpName(name)) return showToast("Name: letters, digits, - or _ only.");
    if (!target) return showToast("Enter an http:// or https:// URL, or a command to run.");
    if (servers.some((s) => s.name === name)) return showToast(`${name} is already listed.`);
    try {
      await save(cwd, [...servers, { name, ...target }]);
      showToast(`Added ${name}. It loads on the next turn.`);
    } catch (e) {
      console.error("[project-settings] mcp add failed", e);
      showToast(`Could not add ${name}: ${e}`);
    }
    await redraw();
  };

  render(
    html`
      ${servers.map(
        (s) => html`
          <div class="mcp-row">
            <div class="mcp-row-main">
              <div class="mcp-row-name">${s.name}</div>
              <div class="mcp-row-url" title=${mcpTargetText(s)}>${mcpTargetText(s)}</div>
            </div>
            ${!s.url
              ? nothing
              : signed[s.url]
                ? html`<span class="mcp-row-state">Signed in</span>`
                : html`<button type="button" class="ps-btn" @click=${() => void signIn(s)}>Sign in</button>`}
            <button type="button" class="ps-revert mcp-row-remove" aria-label=${`Remove ${s.name}`} @click=${() => void remove(s)}>
              <i class="ph ph-x"></i>
            </button>
          </div>
        `,
      )}
      <div class="mcp-add">
        <input id="mcpNewName" class="inline-input" placeholder="name (e.g. rodge)" autocomplete="off" spellcheck="false" />
        <input id="mcpNewUrl" class="inline-input" placeholder="http://localhost:PORT/mcp, or a command to run" autocomplete="off" spellcheck="false" />
        <button type="button" class="ps-btn" @click=${() => void add()}>Add</button>
      </div>
    `,
    root,
  );
}
