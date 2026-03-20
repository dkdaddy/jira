// ─── Strong-typed fetch wrapper ───────────────────────────────────────────────

/** @template T */
async function fetchJSON(/** @type {string} */ url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return /** @type {Promise<T>} */ (res.json());
}

// ─── State ────────────────────────────────────────────────────────────────────

/** @type {{ dashboards: Array<DashboardDef>, org: Record<string,unknown>, initiatives: Record<string,unknown> } | null} */
let appConfig = null;

/** @type {Record<string, FieldMapping>} */
let fieldMappings = {};

/** @type {Array<Record<string, unknown>>} */
let allIssues = [];

/** @type {string} */
let activeDashboardId = '';

/** @type {Record<string, unknown>} */
let filterValues = {};

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const [config, fields, issues, health] = await Promise.all([
      fetchJSON('/api/config'),
      fetchJSON('/api/fields'),
      fetch('/api/data', { cache: 'no-cache' }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
      fetchJSON('/api/health'),
    ]);

    appConfig = /** @type {typeof appConfig} */ (config);
    fieldMappings = /** @type {typeof fieldMappings} */ (fields);
    allIssues = /** @type {typeof allIssues} */ (issues);

    renderSyncIndicator(/** @type {Record<string,unknown>} */ (health));
    renderHeaderStats();
    renderTabs();

    if (appConfig.dashboards.length > 0) {
      switchTab(appConfig.dashboards[0].id);
    }
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }

  // Wire global buttons
  document.getElementById('btn-sync')?.addEventListener('click', syncFromJira);
  document.getElementById('btn-clear')?.addEventListener('click', clearFilters);
  document.getElementById('btn-export-csv')?.addEventListener('click', () => {
    window.location.href = '/api/export/csv';
  });
  document.getElementById('btn-export-json')?.addEventListener('click', () => {
    window.location.href = '/api/export/json';
  });
  document.getElementById('search-input')?.addEventListener('input', () => renderCurrentTab());
});

// ─── Error Display ────────────────────────────────────────────────────────────

function showError(/** @type {string} */ msg) {
  const el = document.getElementById('error-banner');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideError() {
  const el = document.getElementById('error-banner');
  if (el) el.classList.add('hidden');
}

// ─── Header Stats ─────────────────────────────────────────────────────────────

function renderHeaderStats() {
  const el = document.getElementById('header-stats');
  if (!el || !appConfig) return;

  const issueCount = allIssues.length;

  const projects = new Set(allIssues.map((i) => String(i.key ?? '').split('-')[0]).filter(Boolean));

  const teams = new Set(allIssues.map((i) => i.team).filter(Boolean));

  const initiatives = new Set(allIssues.map((i) => i.initiative).filter(Boolean));

  let redCount = 0;
  let yellowCount = 0;
  for (const issue of allIssues) {
    if (issue.healthStatus === 'red') redCount++;
    else if (issue.healthStatus === 'yellow') yellowCount++;
  }

  const stats = [
    { label: 'Issues', value: issueCount },
    { label: 'Projects', value: projects.size },
    { label: 'Teams', value: teams.size },
    { label: 'Initiatives', value: initiatives.size },
    { label: 'At Risk', value: redCount },
    { label: 'Needs Attention', value: yellowCount },
  ];

  el.innerHTML = '';
  for (const s of stats) {
    const span = document.createElement('span');
    span.className = 'stat';
    span.innerHTML = `<span class="stat-value">${s.value}</span> ${s.label}`;
    el.appendChild(span);
  }
}

// ─── Sync Indicator ───────────────────────────────────────────────────────────

function renderSyncIndicator(/** @type {Record<string,unknown>} */ health) {
  const el = document.getElementById('sync-indicator');
  if (!el) return;

  const cache = /** @type {Record<string,unknown> | null} */ (health.cache);
  if (!cache?.lastSync) {
    el.textContent = 'No sync data';
    return;
  }

  const syncDate = new Date(/** @type {string} */ (cache.lastSync));
  const ageMin = /** @type {number} */ (cache.ageMinutes);
  let ageText;
  if (ageMin < 1) ageText = 'just now';
  else if (ageMin < 60) ageText = `${Math.round(ageMin)}m ago`;
  else if (ageMin < 1440) ageText = `${Math.round(ageMin / 60)}h ago`;
  else ageText = `${Math.round(ageMin / 1440)}d ago`;

  el.textContent = `Data as of: ${syncDate.toLocaleString()} (${ageText})`;

  // Stale warning
  if (ageMin > 1440) {
    const content = document.getElementById('content-area');
    if (content) {
      const warn = document.createElement('div');
      warn.className = 'stale-warning';
      warn.textContent = `Warning: Cache is ${Math.round(ageMin / 60)} hours old. Click "Sync from Jira" to fetch fresh data.`;
      content.parentElement?.insertBefore(warn, content);
    }
  }
}

// ─── Refresh ──────────────────────────────────────────────────────────────────

async function refreshData() {
  try {
    const [issues, health] = await Promise.all([
      fetch('/api/data', { cache: 'reload' }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
      fetchJSON('/api/health'),
    ]);
    allIssues = issues;
    renderSyncIndicator(/** @type {Record<string,unknown>} */ (health));
    renderHeaderStats();
    renderCurrentTab();
    hideError();
  } catch (err) {
    showError('Refresh failed: ' + (err instanceof Error ? err.message : String(err)));
  }
}

async function syncFromJira() {
  const btn = document.getElementById('btn-sync');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Syncing…';
  }
  try {
    const resp = await fetch('/api/sync', { method: 'POST' });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${resp.status}`);
    }
    await refreshData();
  } catch (err) {
    showError('Sync failed: ' + (err instanceof Error ? err.message : String(err)));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Sync from Jira';
    }
  }
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

function renderTabs() {
  const bar = document.getElementById('tab-bar');
  if (!bar || !appConfig) return;
  bar.innerHTML = '';

  for (const dash of appConfig.dashboards) {
    const btn = document.createElement('button');
    btn.textContent = dash.title;
    btn.dataset.id = dash.id;
    btn.addEventListener('click', () => switchTab(dash.id));
    bar.appendChild(btn);
  }
}

function switchTab(/** @type {string} */ id) {
  activeDashboardId = id;
  filterValues = {};

  // Update active state
  document.querySelectorAll('#tab-bar button').forEach((btn) => {
    const b = /** @type {HTMLButtonElement} */ (btn);
    b.classList.toggle('active', b.dataset.id === id);
  });

  // Clear search
  const searchInput = /** @type {HTMLInputElement | null} */ (document.getElementById('search-input'));
  if (searchInput) searchInput.value = '';

  renderFilterBar();
  renderCurrentTab();
}

function getActiveDashboard() {
  if (!appConfig) return null;
  return appConfig.dashboards.find((d) => d.id === activeDashboardId) ?? null;
}

// ─── Base Filter Parser ──────────────────────────────────────────────────────

/**
 * Parses baseFilter expressions like:
 *   status = "In Progress"
 *   status IN ("A", "B")
 *   status = "X" AND type IN ("Story", "Epic")
 *   priority != "Low"
 */
function parseBaseFilter(/** @type {string} */ expr) {
  if (!expr.trim()) return () => true;

  const conditions = [];
  // Split on AND (case-insensitive), respecting quoted strings
  const parts = expr.split(/\s+AND\s+/i);

  for (const part of parts) {
    const trimmed = part.trim();

    // field IN ("val1", "val2", ...)
    const inMatch = trimmed.match(/^(\w+)\s+IN\s*\((.+)\)$/i);
    if (inMatch) {
      const field = inMatch[1];
      const values = [...inMatch[2].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      conditions.push((/** @type {Record<string,unknown>} */ issue) => {
        const v = issue[field];
        return v !== null && v !== undefined && values.includes(String(v));
      });
      continue;
    }

    // field != "value"
    const neqMatch = trimmed.match(/^(\w+)\s*!=\s*"([^"]+)"$/);
    if (neqMatch) {
      const field = neqMatch[1];
      const value = neqMatch[2];
      conditions.push((/** @type {Record<string,unknown>} */ issue) => String(issue[field] ?? '') !== value);
      continue;
    }

    // field = "value"
    const eqMatch = trimmed.match(/^(\w+)\s*=\s*"([^"]+)"$/);
    if (eqMatch) {
      const field = eqMatch[1];
      const value = eqMatch[2];
      conditions.push((/** @type {Record<string,unknown>} */ issue) => String(issue[field] ?? '') === value);
      continue;
    }
  }

  return (/** @type {Record<string,unknown>} */ issue) => conditions.every((fn) => fn(issue));
}

// ─── Filter Widgets ──────────────────────────────────────────────────────────

function renderFilterBar() {
  const bar = document.getElementById('filter-bar');
  if (!bar) return;
  bar.innerHTML = '';

  const dash = getActiveDashboard();
  if (!dash) return;

  const baseFilterFn = parseBaseFilter(dash.baseFilter);
  const baseData = allIssues.filter(baseFilterFn);

  for (const fieldName of dash.filterWidgets) {
    const mapping = fieldMappings[fieldName];
    if (!mapping) continue;

    const widget = document.createElement('div');
    widget.className = 'filter-widget';

    const label = document.createElement('label');
    label.textContent = mapping.label;
    widget.appendChild(label);

    switch (mapping.type) {
      case 'dropdown': {
        const select = document.createElement('select');
        select.dataset.field = fieldName;

        const optAll = document.createElement('option');
        optAll.value = '';
        optAll.textContent = `All ${mapping.label}`;
        select.appendChild(optAll);

        const values = [...new Set(baseData.map((i) => i[fieldName]).filter((v) => v !== null && v !== undefined).map(String))].sort();
        for (const v of values) {
          const opt = document.createElement('option');
          opt.value = v;
          opt.textContent = v;
          select.appendChild(opt);
        }

        select.addEventListener('change', () => {
          filterValues[fieldName] = select.value || null;
          renderCurrentTab();
        });

        widget.appendChild(select);
        break;
      }

      case 'text': {
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = `Filter ${mapping.label}...`;
        input.dataset.field = fieldName;

        input.addEventListener('input', () => {
          filterValues[fieldName] = input.value || null;
          renderCurrentTab();
        });

        widget.appendChild(input);
        break;
      }

      case 'number': {
        const wrap = document.createElement('div');
        wrap.style.display = 'flex';
        wrap.style.gap = '0.25rem';

        const minInput = document.createElement('input');
        minInput.type = 'number';
        minInput.placeholder = 'Min';
        minInput.style.width = '60px';

        const maxInput = document.createElement('input');
        maxInput.type = 'number';
        maxInput.placeholder = 'Max';
        maxInput.style.width = '60px';

        const onChange = () => {
          filterValues[fieldName] = {
            min: minInput.value ? Number(minInput.value) : null,
            max: maxInput.value ? Number(maxInput.value) : null,
          };
          renderCurrentTab();
        };
        minInput.addEventListener('input', onChange);
        maxInput.addEventListener('input', onChange);

        wrap.appendChild(minInput);
        wrap.appendChild(maxInput);
        widget.appendChild(wrap);
        break;
      }

      case 'date': {
        const wrap = document.createElement('div');
        wrap.style.display = 'flex';
        wrap.style.gap = '0.25rem';

        const fromInput = document.createElement('input');
        fromInput.type = 'date';
        fromInput.title = 'From';

        const toInput = document.createElement('input');
        toInput.type = 'date';
        toInput.title = 'To';

        const onChange = () => {
          filterValues[fieldName] = {
            from: fromInput.value || null,
            to: toInput.value || null,
          };
          renderCurrentTab();
        };
        fromInput.addEventListener('input', onChange);
        toInput.addEventListener('input', onChange);

        wrap.appendChild(fromInput);
        wrap.appendChild(toInput);
        widget.appendChild(wrap);
        break;
      }

      case 'multiselect': {
        const select = document.createElement('select');
        select.multiple = true;
        select.dataset.field = fieldName;
        select.style.minHeight = '60px';

        const allValues = new Set();
        for (const issue of baseData) {
          const val = issue[fieldName];
          if (Array.isArray(val)) {
            for (const v of val) allValues.add(String(v));
          } else if (val !== null && val !== undefined) {
            allValues.add(String(val));
          }
        }

        for (const v of [...allValues].sort()) {
          const opt = document.createElement('option');
          opt.value = /** @type {string} */ (v);
          opt.textContent = /** @type {string} */ (v);
          select.appendChild(opt);
        }

        select.addEventListener('change', () => {
          const selected = [...select.selectedOptions].map((o) => o.value);
          filterValues[fieldName] = selected.length > 0 ? selected : null;
          renderCurrentTab();
        });

        widget.appendChild(select);
        break;
      }
    }

    bar.appendChild(widget);
  }
}

// ─── Filtering Pipeline ──────────────────────────────────────────────────────

function getFilteredIssues() {
  const dash = getActiveDashboard();
  if (!dash) return [];

  // 1. Base filter
  const baseFilterFn = parseBaseFilter(dash.baseFilter);
  let result = allIssues.filter(baseFilterFn);

  // 2. Search input
  const searchInput = /** @type {HTMLInputElement | null} */ (document.getElementById('search-input'));
  const searchText = searchInput?.value?.toLowerCase() ?? '';
  if (searchText) {
    result = result.filter((issue) => {
      const key = String(issue.key ?? '').toLowerCase();
      const summary = String(issue.summary ?? '').toLowerCase();
      return key.includes(searchText) || summary.includes(searchText);
    });
  }

  // 3. Filter widgets
  for (const [fieldName, value] of Object.entries(filterValues)) {
    if (value === null || value === undefined) continue;

    const mapping = fieldMappings[fieldName];
    if (!mapping) continue;

    switch (mapping.type) {
      case 'dropdown':
        if (typeof value === 'string' && value) {
          result = result.filter((i) => String(i[fieldName] ?? '') === value);
        }
        break;

      case 'text':
        if (typeof value === 'string' && value) {
          const lower = value.toLowerCase();
          result = result.filter((i) => String(i[fieldName] ?? '').toLowerCase().includes(lower));
        }
        break;

      case 'number': {
        const range = /** @type {{ min: number | null, max: number | null }} */ (value);
        result = result.filter((i) => {
          const num = Number(i[fieldName]);
          if (isNaN(num)) return false;
          if (range.min !== null && num < range.min) return false;
          if (range.max !== null && num > range.max) return false;
          return true;
        });
        break;
      }

      case 'date': {
        const range = /** @type {{ from: string | null, to: string | null }} */ (value);
        result = result.filter((i) => {
          const dateStr = i[fieldName];
          if (!dateStr) return false;
          const d = new Date(String(dateStr));
          if (range.from && d < new Date(range.from)) return false;
          if (range.to && d > new Date(range.to + 'T23:59:59')) return false;
          return true;
        });
        break;
      }

      case 'multiselect': {
        const selected = /** @type {string[]} */ (value);
        if (selected.length > 0) {
          result = result.filter((i) => {
            const val = i[fieldName];
            if (Array.isArray(val)) {
              return val.some((v) => selected.includes(String(v)));
            }
            return selected.includes(String(val ?? ''));
          });
        }
        break;
      }
    }
  }

  return result;
}

// ─── Clear Filters ────────────────────────────────────────────────────────────

function clearFilters() {
  filterValues = {};

  const searchInput = /** @type {HTMLInputElement | null} */ (document.getElementById('search-input'));
  if (searchInput) searchInput.value = '';

  // Reset all filter widgets
  document.querySelectorAll('.filter-widget select').forEach((el) => {
    const s = /** @type {HTMLSelectElement} */ (el);
    if (s.multiple) {
      [...s.options].forEach((o) => (o.selected = false));
    } else {
      s.value = '';
    }
  });
  document.querySelectorAll('.filter-widget input').forEach((el) => {
    const inp = /** @type {HTMLInputElement} */ (el);
    inp.value = '';
  });

  renderCurrentTab();
}

// ─── Render Controller ────────────────────────────────────────────────────────

function renderCurrentTab() {
  const dash = getActiveDashboard();
  const content = document.getElementById('content-area');
  if (!content || !dash) return;

  content.innerHTML = '';

  switch (dash.view) {
    case 'flat':
      renderFlatTable(content, dash);
      break;
    case 'org':
      renderOrgView(content);
      break;
    case 'initiative':
      renderInitiativeView(content);
      break;
    case 'project':
      renderProjectView(content);
      break;
    case 'hierarchy':
      renderHierarchyView(content);
      break;
    default:
      renderFlatTable(content, dash);
  }
}

// ─── Flat Table View ──────────────────────────────────────────────────────────

function renderFlatTable(/** @type {HTMLElement} */ container, /** @type {DashboardDef} */ dash) {
  const issues = getFilteredIssues();

  if (issues.length === 0) {
    container.innerHTML = '<div class="empty-state">No issues match the current filters.</div>';
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'data-table-wrap';

  const table = document.createElement('table');
  table.className = 'data-table';

  // Header
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const col of dash.columns) {
    const th = document.createElement('th');
    const mapping = fieldMappings[col];
    th.textContent = mapping ? mapping.label : col;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Body
  const tbody = document.createElement('tbody');
  for (const issue of issues) {
    const tr = document.createElement('tr');
    const health = issue.healthStatus;

    for (const col of dash.columns) {
      const td = document.createElement('td');

      if (col === 'healthStatus') {
        const badge = document.createElement('span');
        badge.className = `health-badge ${health}`;
        td.appendChild(badge);
        const reason = issue.healthReason;
        td.append(String(reason ?? ''));
      } else {
        const val = issue[col];
        td.textContent = formatCellValue(val);
      }

      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
}

function formatCellValue(/** @type {unknown} */ val) {
  if (val === null || val === undefined) return '';
  if (Array.isArray(val)) return val.join(', ');
  return String(val);
}

// ─── Org Roll-up View ─────────────────────────────────────────────────────────

async function renderOrgView(/** @type {HTMLElement} */ container) {
  try {
    const data = await fetchJSON('/api/rollup/org');
    const orgNodes = /** @type {Array<Record<string,unknown>>} */ (data);

    if (orgNodes.length === 0) {
      container.innerHTML = '<div class="empty-state">No org data available.</div>';
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'rollup-grid';

    for (const org of orgNodes) {
      const card = document.createElement('div');
      card.className = 'rollup-card';

      const h2 = document.createElement('h2');
      h2.textContent = /** @type {string} */ (org.org);
      card.appendChild(h2);

      card.appendChild(renderMetrics(/** @type {Record<string,unknown>} */ (org.metrics)));

      const groups = /** @type {Array<Record<string,unknown>>} */ (org.groups);
      for (const group of groups) {
        const h3 = document.createElement('h3');
        h3.textContent = /** @type {string} */ (group.name);
        card.appendChild(h3);

        card.appendChild(renderMetrics(/** @type {Record<string,unknown>} */ (group.metrics)));

        const teams = /** @type {Array<Record<string,unknown>>} */ (group.teams);
        const teamTable = document.createElement('table');
        teamTable.className = 'data-table';
        teamTable.style.marginTop = '0.5rem';

        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        for (const col of ['Team', 'Issues', 'Estimate', 'Complete %', 'Health']) {
          const th = document.createElement('th');
          th.textContent = col;
          headerRow.appendChild(th);
        }
        thead.appendChild(headerRow);
        teamTable.appendChild(thead);

        const tbody = document.createElement('tbody');
        for (const team of teams) {
          const metrics = /** @type {Record<string,unknown>} */ (team.metrics);
          const healthCounts = /** @type {Record<string,number>} */ (metrics.healthCounts);
          const tr = document.createElement('tr');

          addCell(tr, /** @type {string} */ (team.name));
          addCell(tr, String(metrics.issueCount));
          addCell(tr, String(metrics.totalEstimate));
          addCell(tr, `${metrics.completionPct}%`);
          const td = document.createElement('td');
          td.innerHTML =
            `<span class="health-badge green"></span>${healthCounts.green} ` +
            `<span class="health-badge yellow"></span>${healthCounts.yellow} ` +
            `<span class="health-badge red"></span>${healthCounts.red}`;
          tr.appendChild(td);

          tbody.appendChild(tr);
        }
        teamTable.appendChild(tbody);
        card.appendChild(teamTable);
      }

      grid.appendChild(card);
    }

    container.appendChild(grid);
  } catch (err) {
    showError('Failed to load org data: ' + (err instanceof Error ? err.message : String(err)));
  }
}

// ─── Initiative Roll-up View ──────────────────────────────────────────────────

async function renderInitiativeView(/** @type {HTMLElement} */ container) {
  try {
    const data = await fetchJSON('/api/rollup/initiative');
    const goals = /** @type {Array<Record<string,unknown>>} */ (data);

    if (goals.length === 0) {
      container.innerHTML = '<div class="empty-state">No initiative data available.</div>';
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'rollup-grid';

    for (const goal of goals) {
      const card = document.createElement('div');
      card.className = 'rollup-card';

      const h2 = document.createElement('h2');
      h2.textContent = /** @type {string} */ (goal.goal);
      card.appendChild(h2);

      const goalMetrics = /** @type {Record<string,unknown>} */ (goal.metrics);
      card.appendChild(renderProgressMetrics(goalMetrics));

      const initiatives = /** @type {Array<Record<string,unknown>>} */ (goal.initiatives);
      const table = document.createElement('table');
      table.className = 'data-table';
      table.style.marginTop = '0.5rem';

      const thead = document.createElement('thead');
      const headerRow = document.createElement('tr');
      for (const col of ['Initiative', 'Issues', 'Estimate', 'Progress', 'At Risk']) {
        const th = document.createElement('th');
        th.textContent = col;
        headerRow.appendChild(th);
      }
      thead.appendChild(headerRow);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      for (const init of initiatives) {
        const metrics = /** @type {Record<string,unknown>} */ (init.metrics);
        const tr = document.createElement('tr');

        addCell(tr, /** @type {string} */ (init.name));
        addCell(tr, String(metrics.issueCount));
        addCell(tr, String(metrics.totalEstimate));

        const progTd = document.createElement('td');
        progTd.innerHTML = renderProgressBar(/** @type {number} */ (metrics.progress)) + ` ${metrics.progress}%`;
        tr.appendChild(progTd);

        const riskTd = document.createElement('td');
        const atRisk = /** @type {number} */ (metrics.atRisk);
        if (atRisk > 0) {
          riskTd.innerHTML = `<span class="health-badge red"></span>${atRisk}`;
        } else {
          riskTd.textContent = '0';
        }
        tr.appendChild(riskTd);

        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      card.appendChild(table);
      grid.appendChild(card);
    }

    container.appendChild(grid);
  } catch (err) {
    showError('Failed to load initiative data: ' + (err instanceof Error ? err.message : String(err)));
  }
}

// ─── Hierarchy View ───────────────────────────────────────────────────────────

// ─── Project Roll-up View ─────────────────────────────────────────────────────

async function renderProjectView(/** @type {HTMLElement} */ container) {
  try {
    const data = await fetchJSON('/api/rollup/project');
    const projects = /** @type {Array<Record<string,unknown>>} */ (data);

    if (projects.length === 0) {
      container.innerHTML = '<div class="empty-state">No project data available.</div>';
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'rollup-grid';

    for (const proj of projects) {
      const card = document.createElement('div');
      card.className = 'rollup-card';

      const h2 = document.createElement('h2');
      h2.textContent = /** @type {string} */ (proj.project);
      card.appendChild(h2);

      const metrics = /** @type {Record<string,unknown>} */ (proj.metrics);
      card.appendChild(renderMetrics(metrics));

      const healthCounts = /** @type {Record<string,number>} */ (metrics.healthCounts);
      const healthDiv = document.createElement('div');
      healthDiv.className = 'health-summary';
      healthDiv.innerHTML =
        `<span class="health-badge green"></span>${healthCounts.green} ` +
        `<span class="health-badge yellow"></span>${healthCounts.yellow} ` +
        `<span class="health-badge red"></span>${healthCounts.red}`;
      card.appendChild(healthDiv);

      grid.appendChild(card);
    }

    container.appendChild(grid);
  } catch (err) {
    showError('Failed to load project data: ' + (err instanceof Error ? err.message : String(err)));
  }
}

// ─── Hierarchy View ───────────────────────────────────────────────────────────

async function renderHierarchyView(/** @type {HTMLElement} */ container) {
  try {
    const data = await fetchJSON('/api/rollup/hierarchy');
    const roots = /** @type {Array<Record<string,unknown>>} */ (data);

    if (roots.length === 0) {
      container.innerHTML = '<div class="empty-state">No hierarchy data available.</div>';
      return;
    }

    const tree = document.createElement('div');
    tree.className = 'hierarchy-tree';

    for (const root of roots) {
      tree.appendChild(buildHierarchyNode(root, true));
    }

    container.appendChild(tree);
  } catch (err) {
    showError('Failed to load hierarchy data: ' + (err instanceof Error ? err.message : String(err)));
  }
}

function buildHierarchyNode(/** @type {Record<string,unknown>} */ node, /** @type {boolean} */ isRoot) {
  const children = /** @type {Array<Record<string,unknown>>} */ (node.children ?? []);
  const metrics = /** @type {Record<string,unknown>} */ (node.metrics ?? {});
  const hasChildren = children.length > 0;

  const wrapper = document.createElement('div');
  wrapper.className = `hierarchy-node${isRoot ? ' root' : ''}`;

  // Row
  const row = document.createElement('div');
  row.className = 'hierarchy-row';

  // Toggle
  const toggle = document.createElement('span');
  toggle.className = 'hierarchy-toggle';
  toggle.textContent = hasChildren ? '▾' : ' ';
  row.appendChild(toggle);

  // Key
  const keySpan = document.createElement('span');
  keySpan.className = 'hierarchy-key';
  keySpan.textContent = /** @type {string} */ (node.key);
  row.appendChild(keySpan);

  // Type badge
  const typeBadge = document.createElement('span');
  typeBadge.className = 'hierarchy-type';
  typeBadge.textContent = /** @type {string} */ (node.issueType);
  row.appendChild(typeBadge);

  // Summary
  const summary = document.createElement('span');
  summary.className = 'hierarchy-summary';
  summary.textContent = /** @type {string} */ (node.summary);
  row.appendChild(summary);

  // Metrics
  const metricsSpan = document.createElement('span');
  metricsSpan.className = 'hierarchy-metrics';
  const healthVal = /** @type {string} */ (metrics.healthStatus ?? 'green');
  metricsSpan.innerHTML =
    `<span class="health-badge ${healthVal}"></span>` +
    `${metrics.completionPct ?? 0}% · ${metrics.issueCount ?? 0} issues · est: ${metrics.totalEstimate ?? 0}`;
  row.appendChild(metricsSpan);

  wrapper.appendChild(row);

  // Children
  if (hasChildren) {
    const childContainer = document.createElement('div');
    childContainer.className = 'hierarchy-children';

    for (const child of children) {
      childContainer.appendChild(buildHierarchyNode(child, false));
    }

    wrapper.appendChild(childContainer);

    // Toggle expand/collapse
    row.addEventListener('click', () => {
      const isCollapsed = childContainer.classList.toggle('collapsed');
      toggle.textContent = isCollapsed ? '▸' : '▾';
    });
  }

  return wrapper;
}

// ─── Render Helpers ───────────────────────────────────────────────────────────

function addCell(/** @type {HTMLTableRowElement} */ tr, /** @type {string} */ text) {
  const td = document.createElement('td');
  td.textContent = text;
  tr.appendChild(td);
}

function renderMetrics(/** @type {Record<string,unknown>} */ metrics) {
  const div = document.createElement('div');
  div.className = 'rollup-metrics';

  const items = [
    ['Issues', metrics.issueCount],
    ['Estimate', metrics.totalEstimate],
    ['Complete', `${metrics.completionPct}%`],
  ];

  for (const [label, value] of items) {
    const m = document.createElement('div');
    m.className = 'metric';
    const mv = document.createElement('span');
    mv.className = 'metric-value';
    mv.textContent = String(value);
    const ml = document.createElement('span');
    ml.className = 'metric-label';
    ml.textContent = /** @type {string} */ (label);
    m.appendChild(mv);
    m.appendChild(ml);
    div.appendChild(m);
  }

  return div;
}

function renderProgressMetrics(/** @type {Record<string,unknown>} */ metrics) {
  const div = document.createElement('div');
  div.className = 'rollup-metrics';

  const items = [
    ['Issues', metrics.issueCount],
    ['Estimate', metrics.totalEstimate],
    ['Progress', `${metrics.progress}%`],
    ['At Risk', metrics.atRisk],
  ];

  for (const [label, value] of items) {
    const m = document.createElement('div');
    m.className = 'metric';
    const mv = document.createElement('span');
    mv.className = 'metric-value';
    mv.textContent = String(value);
    const ml = document.createElement('span');
    ml.className = 'metric-label';
    ml.textContent = /** @type {string} */ (label);
    m.appendChild(mv);
    m.appendChild(ml);
    div.appendChild(m);
  }

  return div;
}

function renderProgressBar(/** @type {number} */ pct) {
  return `<span class="progress-bar"><span class="progress-bar-fill" style="width:${Math.min(100, pct)}%"></span></span>`;
}

// ─── JSDoc Types (for IDE support in vanilla JS) ──────────────────────────────

/**
 * @typedef {{ id: string, title: string, view: string, baseFilter: string, filterWidgets: string[], columns: string[] }} DashboardDef
 * @typedef {{ path: string, type: string, label: string }} FieldMapping
 */
