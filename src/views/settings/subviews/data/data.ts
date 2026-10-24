import { html, render } from "lit-html";
import { api } from "../../../../shared/api";
import type { DatasetInfo, DatasetId, RetentionPolicy } from "../../../../types/ipc.generated";
import { isRemote } from "../../../../shared/transport";
import { askConfirm } from "../../../../shared/confirm";
import { settingsHeader, selectHtml, escapeHtml } from "../../ui";
import "./data.css";

const RETENTION_OPTIONS: { value: RetentionPolicy; label: string }[] = [
  { value: "forever", label: "Never" },
  { value: "365d", label: "1 year" },
  { value: "90d", label: "90 days" },
  { value: "30d", label: "30 days" },
  { value: "7d", label: "7 days" },
];

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// "52340" -> "52,340". record_count arrives as bigint (unix-second counts can
// exceed safe-int territory only in theory, but bigint formats fine via String).
function formatCount(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// unix SECONDS (bigint) -> "Mon YYYY". Multiply into ms as a Number; even far-
// future second values stay well within Number's safe range.
function formatMonthYear(unixSeconds: bigint): string {
  const d = new Date(Number(unixSeconds) * 1000);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function formatBytes(bytes: bigint): string {
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

function datasetSubline(info: DatasetInfo): string {
  if (info.record_count === BigInt(0) || info.oldest_entry === null || info.newest_entry === null) {
    return "No data yet";
  }
  const range = `${formatMonthYear(info.oldest_entry)} - ${formatMonthYear(info.newest_entry)}`;
  return `${formatCount(info.record_count)} records · ${range}`;
}

function dataCardHtml(info: DatasetInfo): string {
  const select = selectHtml({
    className: "data-retention",
    dataset: { dataset: info.dataset },
    options: RETENTION_OPTIONS,
    selected: info.retention,
  });
  return `
    <div class="kit-section data-card">
      <div class="data-card-head">
        <span class="kit-row-label">${escapeHtml(info.label)}</span>
        <span class="data-card-sub">${escapeHtml(datasetSubline(info))}</span>
      </div>
      <div class="kit-row data-card-controls">
        <span class="kit-row-label data-control-label">Keep for</span>
        <div class="data-control-actions">
          ${select}
          <button class="btn-danger data-clear" data-dataset="${info.dataset}">Clear all</button>
        </div>
      </div>
    </div>`;
}

let dataWired = false;

async function refreshDataSection(): Promise<void> {
  const cards = document.getElementById("dataCards");
  const totalEl = document.getElementById("dataTotal");
  if (!cards || !totalEl) return;

  const infos = await api.getStorageInfo();
  cards.innerHTML = infos.map(dataCardHtml).join("");

  // total_db_bytes is identical on every entry; read it once.
  const first = infos[0];
  if (first) {
    totalEl.textContent = `Total: ${formatBytes(first.total_db_bytes)}`;
    totalEl.style.display = "";
  } else {
    totalEl.style.display = "none";
  }

  // Delegated listeners bound once to the stable container, so re-rendering the
  // innerHTML on refresh doesn't accumulate handlers.
  if (!dataWired) {
    dataWired = true;
    cards.addEventListener("change", (e) => {
      const sel = (e.target as HTMLElement)?.closest<HTMLSelectElement>("select.data-retention");
      if (!sel) return;
      const dataset = sel.dataset.dataset as DatasetId | undefined;
      if (!dataset) return;
      const policy = sel.value as RetentionPolicy;
      void (async () => {
        try {
          await api.setRetentionPolicy(dataset, policy);
          await refreshDataSection();
        } catch (err) {
          console.error("[settings-data] set retention failed", err);
        }
      })();
    });
    cards.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement)?.closest<HTMLButtonElement>("button.data-clear");
      if (!btn) return;
      const dataset = btn.dataset.dataset as DatasetId | undefined;
      if (!dataset) return;
      const label = btn.closest(".data-card")?.querySelector(".kit-row-label")?.textContent ?? dataset;
      void (async () => {
        if (!(await askConfirm(`Clear all ${label} data?`, { confirmLabel: "Clear" }))) return;
        try {
          await api.clearDataset(dataset);
          await refreshDataSection();
        } catch (err) {
          console.error("[settings-data] clear dataset failed", err);
        }
      })();
    });
  }
}

export async function renderDataView(root: HTMLElement): Promise<() => void> {
  render(template(), root);

  if (!isRemote()) {
    // Fresh container each render -> rebind the delegated listeners.
    dataWired = false;
    try { await refreshDataSection(); }
    catch (e) { console.error("[settings-data] render failed", e); }
  }

  return () => {};
}

function template() {
  return html`
    <div class="view view-settings-data">
      ${settingsHeader("Data & storage")}
      <div class="view-body">

        ${isRemote() ? "" : html`
          <div class="kit-section" id="dataSection">
            <div class="kit-section-title">Data &amp; storage</div>
            <!-- Cards injected as a plain innerHTML string (NOT a lit .map):
                 production lit-html silently drops repeated/nested templates
                 containing a <select>. See project memory. -->
            <div id="dataCards" class="data-cards"></div>
            <div id="dataTotal" class="data-total"></div>
          </div>
        `}

      </div>
    </div>
  `;
}
