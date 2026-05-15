/**
 * Minimal chat rendering: plain text (with line breaks) and GitHub-style pipe tables.
 * Builds DOM with text nodes / createElement only (no HTML injection).
 */

function isSeparatorRow(cells) {
  if (!cells.length) return false;
  return cells.every((c) => c === '' || /^:?-{3,}:?$/.test(c));
}

/**
 * @param {string} s
 * @param {number} offset — index of row-leading '|'
 * @returns {{ cells: string[], end: number } | null}
 */
function parseOneRow(s, offset) {
  const n = s.length;
  if (offset >= n || s[offset] !== '|') return null;

  let i = offset + 1;
  const cells = [];
  let cell = '';
  while (i < n) {
    const c = s[i];
    if (c === '|') {
      cells.push(cell.trim());
      cell = '';
      i++;
      continue;
    }
    if (c === '\n' || (c === '\r' && s[i + 1] === '\n')) {
      if (c === '\r') i++;
      i++;
      if (cell.trim().length) cells.push(cell.trim());
      break;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    cell += c;
    i++;
  }
  if (i >= n && cell.trim().length) cells.push(cell.trim());

  if (cells.length < 2) return null;
  return { cells, end: i };
}

function skipInterRowSpace(s, i) {
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === '\r' && s[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (c === '\n' || c === '\r') {
      i++;
      continue;
    }
    break;
  }
  return i;
}

/**
 * @param {string} s
 * @param {number} offset — index of leading '|' of header row
 * @returns {{ rows: string[][], end: number } | null}
 */
function consumePipeTable(s, offset) {
  const r1 = parseOneRow(s, offset);
  if (!r1) return null;

  let i = skipInterRowSpace(s, r1.end);
  const r2 = parseOneRow(s, i);
  if (!r2 || !isSeparatorRow(r2.cells)) return null;

  i = skipInterRowSpace(s, r2.end);
  const rows = [r1.cells, r2.cells];

  while (i < s.length) {
    if (s[i] !== '|') break;
    const rn = parseOneRow(s, i);
    if (!rn) break;
    rows.push(rn.cells);
    i = skipInterRowSpace(s, rn.end);
  }

  const headerCols = rows[0].length;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    while (row.length < headerCols) row.push('');
    while (row.length > headerCols) row.pop();
  }

  return { rows, end: i };
}

function appendPlainWithBreaks(parent, text) {
  if (!text) return;
  const parts = text.split('\n');
  for (let k = 0; k < parts.length; k++) {
    if (k) parent.append(document.createElement('br'));
    parent.append(document.createTextNode(parts[k]));
  }
}

function buildTableEl(rows) {
  const table = document.createElement('table');
  table.className = 'chat-md-table';
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  for (const h of rows[0]) {
    const th = document.createElement('th');
    th.textContent = h;
    trh.append(th);
  }
  thead.append(trh);
  table.append(thead);
  const tbody = document.createElement('tbody');
  for (let r = 2; r < rows.length; r++) {
    const tr = document.createElement('tr');
    for (const cell of rows[r]) {
      const td = document.createElement('td');
      td.textContent = cell;
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  return table;
}

/**
 * Replace children with plain segments and <table> where pipe-tables are detected.
 * @param {HTMLElement} root
 * @param {string} text
 */
export function renderChatRichContent(root, text) {
  root.replaceChildren();
  if (!text) return;

  let pos = 0;
  while (pos < text.length) {
    const idx = text.indexOf('|', pos);
    if (idx === -1) {
      appendPlainWithBreaks(root, text.slice(pos));
      break;
    }
    if (idx > pos) appendPlainWithBreaks(root, text.slice(pos, idx));

    const table = consumePipeTable(text, idx);
    if (table) {
      root.append(buildTableEl(table.rows));
      pos = table.end;
    } else {
      root.append(document.createTextNode('|'));
      pos = idx + 1;
    }
  }
}
