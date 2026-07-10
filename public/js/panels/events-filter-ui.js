/**
 * Shared Events filter widgets: date calendar (individual days or range) + attendance.
 */

/**
 * @param {string | null | undefined} ymd
 * @returns {Date | null}
 */
export function parseYmd(ymd) {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/**
 * @param {Date} d
 * @returns {string}
 */
export function formatYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeDateList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const s = String(item || '').trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  out.sort();
  return out;
}

/**
 * @param {string | null | undefined} attendance
 * @returns {{ inPerson: boolean, online: boolean }}
 */
export function attendanceToChecks(attendance) {
  const a = String(attendance || 'any')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (a === 'online') return { inPerson: false, online: true };
  if (a === 'in_person') return { inPerson: true, online: false };
  return { inPerson: true, online: true };
}

/**
 * @param {{ inPerson: boolean, online: boolean }} checks
 * @returns {'any' | 'in_person' | 'online'}
 */
export function checksToAttendance(checks) {
  if (checks.inPerson && checks.online) return 'any';
  if (checks.online && !checks.inPerson) return 'online';
  if (checks.inPerson && !checks.online) return 'in_person';
  return 'any';
}

/**
 * Clickable month calendar — pick individual days (default) or a contiguous range.
 * @param {{
 *   idPrefix?: string,
 *   classPrefix?: string,
 *   dateFrom?: string | null,
 *   dateTo?: string | null,
 *   dates?: string[] | null,
 *   mode?: 'days' | 'range',
 * }} [opts]
 * @returns {{
 *   root: HTMLElement,
 *   getRange: () => { dateFrom: string | null, dateTo: string | null, dates: string[] },
 *   setRange: (from: string | null, to: string | null, dates?: string[] | null) => void,
 *   setDisabled: (disabled: boolean) => void,
 * }}
 */
export function createRangeCalendar(opts = {}) {
  const prefix = opts.classPrefix || 'events-cal';
  const idPrefix = opts.idPrefix || 'events-cal';

  const root = document.createElement('div');
  root.className = prefix;
  root.id = `${idPrefix}-root`;

  const modeRow = document.createElement('div');
  modeRow.className = `${prefix}__modes`;
  modeRow.setAttribute('role', 'group');
  modeRow.setAttribute('aria-label', 'Date selection mode');

  /**
   * @param {'days' | 'range'} value
   * @param {string} label
   */
  function makeModeBtn(value, label) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `${prefix}__mode`;
    btn.dataset.mode = value;
    btn.textContent = label;
    modeRow.append(btn);
    return btn;
  }

  const daysModeBtn = makeModeBtn('days', 'Pick days');
  const rangeModeBtn = makeModeBtn('range', 'Date range');

  const head = document.createElement('div');
  head.className = `${prefix}__head`;

  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = `${prefix}__nav`;
  prevBtn.setAttribute('aria-label', 'Previous month');
  prevBtn.textContent = '‹';

  const title = document.createElement('p');
  title.className = `${prefix}__title`;
  title.setAttribute('aria-live', 'polite');

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = `${prefix}__nav`;
  nextBtn.setAttribute('aria-label', 'Next month');
  nextBtn.textContent = '›';

  head.append(prevBtn, title, nextBtn);

  const summary = document.createElement('p');
  summary.className = `${prefix}__summary`;

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = `${prefix}__clear`;
  clearBtn.textContent = 'Clear dates';

  const dow = document.createElement('div');
  dow.className = `${prefix}__dow`;
  for (const d of ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']) {
    const cell = document.createElement('span');
    cell.textContent = d;
    dow.append(cell);
  }

  const grid = document.createElement('div');
  grid.className = `${prefix}__grid`;
  grid.setAttribute('role', 'grid');

  root.append(modeRow, head, summary, clearBtn, dow, grid);

  const now = new Date();
  let viewYear = now.getFullYear();
  let viewMonth = now.getMonth();
  /** @type {'days' | 'range'} */
  let mode =
    opts.mode === 'range'
      ? 'range'
      : Array.isArray(opts.dates) && opts.dates.length
        ? 'days'
        : opts.dateFrom || opts.dateTo
          ? 'range'
          : 'days';
  /** @type {Set<string>} */
  let selectedDays = new Set(normalizeDateList(opts.dates));
  /** @type {string | null} */
  let dateFrom = opts.dateFrom || null;
  /** @type {string | null} */
  let dateTo = opts.dateTo || null;
  /** @type {'from' | 'to'} */
  let pickPhase = dateFrom && !dateTo ? 'to' : 'from';
  let disabled = false;

  function syncModeButtons() {
    daysModeBtn.classList.toggle(`${prefix}__mode--active`, mode === 'days');
    rangeModeBtn.classList.toggle(`${prefix}__mode--active`, mode === 'range');
    daysModeBtn.setAttribute('aria-pressed', mode === 'days' ? 'true' : 'false');
    rangeModeBtn.setAttribute('aria-pressed', mode === 'range' ? 'true' : 'false');
    grid.setAttribute(
      'aria-label',
      mode === 'days' ? 'Select individual dates' : 'Select date range',
    );
  }

  function updateSummary() {
    if (mode === 'days') {
      const list = [...selectedDays].sort();
      if (!list.length) {
        summary.textContent = 'Any dates — click days to include (toggle on/off)';
        return;
      }
      if (list.length <= 3) {
        summary.textContent = list.join(', ');
        return;
      }
      summary.textContent = `${list.length} days selected (${list[0]} … ${list[list.length - 1]})`;
      return;
    }
    if (!dateFrom && !dateTo) {
      summary.textContent = 'Any dates — click a day to start a range';
      return;
    }
    if (dateFrom && !dateTo) {
      summary.textContent = `${dateFrom} → pick end date`;
      return;
    }
    summary.textContent = `${dateFrom} → ${dateTo}`;
  }

  function paint() {
    syncModeButtons();
    title.textContent = new Date(viewYear, viewMonth, 1).toLocaleString(undefined, {
      month: 'long',
      year: 'numeric',
    });
    grid.replaceChildren();

    const first = new Date(viewYear, viewMonth, 1);
    const startPad = first.getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

    for (let i = 0; i < startPad; i += 1) {
      const empty = document.createElement('span');
      empty.className = `${prefix}__day ${prefix}__day--empty`;
      empty.setAttribute('aria-hidden', 'true');
      grid.append(empty);
    }

    const from = dateFrom;
    const to = dateTo || dateFrom;

    for (let day = 1; day <= daysInMonth; day += 1) {
      const ymd = formatYmd(new Date(viewYear, viewMonth, day));
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `${prefix}__day`;
      btn.textContent = String(day);
      btn.dataset.ymd = ymd;
      btn.disabled = disabled;

      if (mode === 'days') {
        if (selectedDays.has(ymd)) {
          btn.classList.add(`${prefix}__day--selected`);
          btn.setAttribute('aria-pressed', 'true');
        } else {
          btn.setAttribute('aria-pressed', 'false');
        }
      } else {
        if (from && to && ymd >= from && ymd <= to) {
          btn.classList.add(`${prefix}__day--in-range`);
        }
        if (ymd === dateFrom) btn.classList.add(`${prefix}__day--start`);
        if (ymd === dateTo || (dateFrom && !dateTo && ymd === dateFrom)) {
          btn.classList.add(`${prefix}__day--end`);
        }
      }
      if (ymd === formatYmd(now)) btn.classList.add(`${prefix}__day--today`);

      btn.addEventListener('click', () => {
        if (disabled) return;
        if (mode === 'days') {
          if (selectedDays.has(ymd)) selectedDays.delete(ymd);
          else selectedDays.add(ymd);
          updateSummary();
          paint();
          return;
        }
        if (pickPhase === 'from' || (dateFrom && dateTo)) {
          dateFrom = ymd;
          dateTo = null;
          pickPhase = 'to';
        } else {
          if (ymd < /** @type {string} */ (dateFrom)) {
            dateTo = dateFrom;
            dateFrom = ymd;
          } else if (ymd === dateFrom) {
            dateTo = ymd;
          } else {
            dateTo = ymd;
          }
          pickPhase = 'from';
        }
        updateSummary();
        paint();
      });

      grid.append(btn);
    }

    updateSummary();
  }

  /**
   * @param {'days' | 'range'} next
   */
  function setMode(next) {
    if (next === mode) return;
    if (next === 'days') {
      // Carry over current range into discrete days when switching.
      if (!selectedDays.size && dateFrom) {
        const end = dateTo || dateFrom;
        const start = parseYmd(dateFrom);
        const stop = parseYmd(end);
        if (start && stop) {
          for (let t = start.getTime(); t <= stop.getTime(); t += 86400000) {
            selectedDays.add(formatYmd(new Date(t)));
          }
        }
      }
      dateFrom = null;
      dateTo = null;
      pickPhase = 'from';
    } else {
      const list = [...selectedDays].sort();
      if (list.length) {
        dateFrom = list[0];
        dateTo = list[list.length - 1];
      }
      selectedDays = new Set();
      pickPhase = dateFrom && !dateTo ? 'to' : 'from';
    }
    mode = next;
    paint();
  }

  daysModeBtn.addEventListener('click', () => {
    if (!disabled) setMode('days');
  });
  rangeModeBtn.addEventListener('click', () => {
    if (!disabled) setMode('range');
  });

  prevBtn.addEventListener('click', () => {
    if (disabled) return;
    viewMonth -= 1;
    if (viewMonth < 0) {
      viewMonth = 11;
      viewYear -= 1;
    }
    paint();
  });

  nextBtn.addEventListener('click', () => {
    if (disabled) return;
    viewMonth += 1;
    if (viewMonth > 11) {
      viewMonth = 0;
      viewYear += 1;
    }
    paint();
  });

  clearBtn.addEventListener('click', () => {
    if (disabled) return;
    selectedDays = new Set();
    dateFrom = null;
    dateTo = null;
    pickPhase = 'from';
    paint();
  });

  paint();

  return {
    root,
    getRange() {
      if (mode === 'days') {
        const dates = [...selectedDays].sort();
        return {
          dates,
          dateFrom: null,
          dateTo: null,
        };
      }
      return {
        dates: [],
        dateFrom: dateFrom || null,
        dateTo: dateTo || dateFrom || null,
      };
    },
    setRange(from, to, dates) {
      const list = normalizeDateList(dates);
      if (list.length) {
        mode = 'days';
        selectedDays = new Set(list);
        dateFrom = null;
        dateTo = null;
        pickPhase = 'from';
        const d = parseYmd(list[0]);
        if (d) {
          viewYear = d.getFullYear();
          viewMonth = d.getMonth();
        }
      } else {
        mode = from || to ? 'range' : mode;
        selectedDays = new Set();
        dateFrom = from || null;
        dateTo = to || null;
        if (dateFrom && dateTo && dateTo < dateFrom) {
          const tmp = dateFrom;
          dateFrom = dateTo;
          dateTo = tmp;
        }
        pickPhase = dateFrom && !dateTo ? 'to' : 'from';
        if (dateFrom) {
          const d = parseYmd(dateFrom);
          if (d) {
            viewYear = d.getFullYear();
            viewMonth = d.getMonth();
          }
        }
      }
      paint();
    },
    setDisabled(next) {
      disabled = Boolean(next);
      prevBtn.disabled = disabled;
      nextBtn.disabled = disabled;
      clearBtn.disabled = disabled;
      daysModeBtn.disabled = disabled;
      rangeModeBtn.disabled = disabled;
      paint();
    },
  };
}

/**
 * Attendance as In person / Online checkboxes.
 * @param {{
 *   idPrefix?: string,
 *   classPrefix?: string,
 *   attendance?: string | null,
 * }} [opts]
 * @returns {{
 *   root: HTMLElement,
 *   getAttendance: () => 'any' | 'in_person' | 'online',
 *   setAttendance: (attendance: string | null | undefined) => void,
 *   setDisabled: (disabled: boolean) => void,
 * }}
 */
export function createAttendanceChecks(opts = {}) {
  const prefix = opts.classPrefix || 'events-finder';
  const idPrefix = opts.idPrefix || 'events-finder-att';

  const root = document.createElement('div');
  root.className = `${prefix}__checkboxes ${prefix}__checkboxes--attendance`;
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Attendance');

  const checks = attendanceToChecks(opts.attendance);

  /**
   * @param {string} value
   * @param {string} labelText
   * @param {boolean} checked
   */
  function makeCheck(value, labelText, checked) {
    const id = `${idPrefix}-${value}`;
    const row = document.createElement('label');
    row.className = `${prefix}__check`;
    row.htmlFor = id;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.value = value;
    input.checked = checked;
    const span = document.createElement('span');
    span.textContent = labelText;
    row.append(input, span);
    root.append(row);
    return input;
  }

  const inPerson = makeCheck('in_person', 'In person', checks.inPerson);
  const online = makeCheck('online', 'Online', checks.online);

  return {
    root,
    getAttendance() {
      return checksToAttendance({
        inPerson: inPerson.checked,
        online: online.checked,
      });
    },
    setAttendance(attendance) {
      const next = attendanceToChecks(attendance);
      inPerson.checked = next.inPerson;
      online.checked = next.online;
    },
    setDisabled(disabled) {
      inPerson.disabled = disabled;
      online.disabled = disabled;
    },
  };
}
