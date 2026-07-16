import { contactActions } from '../lib/contact-deep-links.js';

/**
 * @param {object} c
 * @returns {string}
 */
function contactName(c) {
  return String(c?.displayName || '').trim() || 'Unnamed';
}

/**
 * @param {object} g
 * @returns {string}
 */
function groupName(g) {
  return String(g?.name || '').trim() || 'Untitled group';
}

/**
 * @param {object} g
 * @returns {string}
 */
function groupKindLabel(g) {
  return String(g?.kind || '').toLowerCase() === 'event' ? 'Event' : 'Community';
}

/**
 * @param {object} g
 * @returns {number}
 */
function memberCount(g) {
  return Array.isArray(g?.memberIds) ? g.memberIds.length : 0;
}

/**
 * Mobile Network Groups: list → members → contact deep links.
 * @param {HTMLElement | null} root
 */
export function mountNetworkGroupsMobile(root) {
  if (!root) return;
  root.replaceChildren();
  root.classList.add('mobile-network', 'mobile-groups');

  const toolbar = document.createElement('div');
  toolbar.className = 'mobile-network__toolbar';

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'mobile-network__search';
  search.placeholder = 'Search groups';
  search.autocomplete = 'off';
  search.setAttribute('aria-label', 'Search groups');
  toolbar.append(search);

  const listPane = document.createElement('div');
  listPane.className = 'mobile-network__list-pane';
  const list = document.createElement('ul');
  list.className = 'mobile-network__list';
  listPane.append(list);

  const detailPane = document.createElement('div');
  detailPane.className = 'mobile-network__detail-pane';
  detailPane.hidden = true;

  const status = document.createElement('p');
  status.className = 'mobile-network__status';
  status.textContent = 'Loading…';

  root.append(toolbar, status, listPane, detailPane);

  /** @type {object[]} */
  let groups = [];
  /** @type {Map<string, object>} */
  let contactMap = new Map();
  /** @type {'list' | 'group' | 'contact'} */
  let view = 'list';
  /** @type {object | null} */
  let selectedGroup = null;

  /**
   * @param {string} q
   * @returns {object[]}
   */
  function filtered(q) {
    const needle = String(q || '')
      .trim()
      .toLowerCase();
    const items = groups.slice().sort((a, b) => {
      const ka = groupKindLabel(a);
      const kb = groupKindLabel(b);
      if (ka !== kb) return ka.localeCompare(kb);
      return groupName(a).localeCompare(groupName(b), undefined, { sensitivity: 'base' });
    });
    if (!needle) return items;
    return items.filter((g) => {
      const hay = [groupName(g), groupKindLabel(g), g.description, g.eventType]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(needle);
    });
  }

  function showList() {
    view = 'list';
    selectedGroup = null;
    detailPane.hidden = true;
    detailPane.replaceChildren();
    listPane.hidden = false;
    toolbar.hidden = false;
  }

  /**
   * @param {object} contact
   * @param {object} group
   */
  function showContact(contact, group) {
    view = 'contact';
    listPane.hidden = true;
    toolbar.hidden = true;
    detailPane.hidden = false;
    detailPane.replaceChildren();

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'mobile-network__back';
    back.textContent = `← ${groupName(group)}`;
    back.addEventListener('click', () => showGroup(group));

    const head = document.createElement('div');
    head.className = 'mobile-network__detail-head';
    const avatar = document.createElement('div');
    avatar.className = 'mobile-network__avatar mobile-network__avatar--lg';
    const avatarUrl = String(contact.avatarUrl || '').trim();
    if (avatarUrl) {
      const img = document.createElement('img');
      img.src = avatarUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      avatar.append(img);
    } else {
      avatar.textContent = contactName(contact).slice(0, 1).toUpperCase();
    }
    const titles = document.createElement('div');
    titles.className = 'mobile-network__detail-titles';
    const nameEl = document.createElement('h2');
    nameEl.className = 'mobile-network__detail-name';
    nameEl.textContent = contactName(contact);
    const sub = document.createElement('p');
    sub.className = 'mobile-network__detail-sub';
    const nick = String(contact.nickname || '').trim();
    const org = String(contact.organizationName || contact.org || '').trim();
    const subText = [nick, org].filter(Boolean).join(' · ');
    if (subText) sub.textContent = subText;
    else sub.hidden = true;
    titles.append(nameEl, sub);
    head.append(avatar, titles);

    const prefHead = document.createElement('div');
    prefHead.className = 'mobile-network__section-head';
    const prefTitle = document.createElement('h3');
    prefTitle.className = 'mobile-network__section-title';
    prefTitle.textContent = 'Preferred contact methods';
    prefHead.append(prefTitle);

    const linksBox = document.createElement('div');
    linksBox.className = 'mobile-network__pref-links';
    const preferred = new Set(
      (Array.isArray(contact.preferredContactMethods)
        ? contact.preferredContactMethods
        : []
      ).map((m) => String(m)),
    );
    const actions = contactActions(contact).filter((a) => {
      if (!a.href) return false;
      if (!preferred.size) return true;
      if (a.id === 'sms') return preferred.has('phone');
      if (a.id === 'office_phone') return preferred.has('office_phone');
      return preferred.has(a.id);
    });
    if (!actions.length) {
      const empty = document.createElement('p');
      empty.className = 'mobile-network__empty';
      empty.textContent = 'No openable contact methods on file.';
      linksBox.append(empty);
    } else {
      for (const a of actions) {
        const link = document.createElement('a');
        link.className = 'mobile-network__action';
        link.href = a.href;
        if (/^https?:/i.test(a.href)) {
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
        }
        link.textContent = a.label;
        linksBox.append(link);
      }
    }

    const section = document.createElement('div');
    section.className = 'mobile-network__section';
    section.append(prefHead, linksBox);

    detailPane.append(back, head, section);
  }

  /**
   * @param {object} group
   */
  function showGroup(group) {
    view = 'group';
    selectedGroup = group;
    listPane.hidden = true;
    toolbar.hidden = true;
    detailPane.hidden = false;
    detailPane.replaceChildren();

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'mobile-network__back';
    back.textContent = '← Groups';
    back.addEventListener('click', () => {
      showList();
      renderList();
    });

    const head = document.createElement('div');
    head.className = 'mobile-network__detail-head';
    const titles = document.createElement('div');
    titles.className = 'mobile-network__detail-titles';
    const nameEl = document.createElement('h2');
    nameEl.className = 'mobile-network__detail-name';
    nameEl.textContent = groupName(group);
    const sub = document.createElement('p');
    sub.className = 'mobile-network__detail-sub';
    const bits = [groupKindLabel(group), `${memberCount(group)} member${memberCount(group) === 1 ? '' : 's'}`];
    if (group.eventType) bits.push(String(group.eventType));
    sub.textContent = bits.join(' · ');
    titles.append(nameEl, sub);
    head.append(titles);

    const desc = String(group.description || '').trim();
    /** @type {HTMLElement[]} */
    const blocks = [back, head];
    if (desc) {
      const descEl = document.createElement('p');
      descEl.className = 'mobile-groups__desc';
      descEl.textContent = desc;
      blocks.push(descEl);
    }

    const membersLabel = document.createElement('h3');
    membersLabel.className = 'mobile-network__section-title';
    membersLabel.textContent = 'Members';
    blocks.push(membersLabel);

    const members = document.createElement('ul');
    members.className = 'mobile-network__list';
    const ids = Array.isArray(group.memberIds) ? group.memberIds : [];
    if (!ids.length) {
      const empty = document.createElement('p');
      empty.className = 'mobile-network__empty';
      empty.textContent = 'No members yet.';
      blocks.push(empty);
    } else {
      const sorted = ids
        .map((id) => contactMap.get(String(id)) || { id, displayName: 'Unknown contact' })
        .sort((a, b) =>
          contactName(a).localeCompare(contactName(b), undefined, { sensitivity: 'base' }),
        );
      for (const c of sorted) {
        const li = document.createElement('li');
        li.className = 'mobile-network__row';
        const avatar = document.createElement('div');
        avatar.className = 'mobile-network__avatar';
        const avatarUrl = String(c.avatarUrl || '').trim();
        if (avatarUrl) {
          const img = document.createElement('img');
          img.src = avatarUrl;
          img.alt = '';
          img.loading = 'lazy';
          img.referrerPolicy = 'no-referrer';
          avatar.append(img);
        } else {
          avatar.textContent = contactName(c).slice(0, 1).toUpperCase();
        }
        const body = document.createElement('div');
        body.className = 'mobile-network__row-body';
        const name = document.createElement('div');
        name.className = 'mobile-network__row-name';
        name.textContent = contactName(c);
        const rowSub = document.createElement('div');
        rowSub.className = 'mobile-network__row-sub';
        const nick = String(c.nickname || '').trim();
        const org = String(c.organizationName || c.org || '').trim();
        const subText = [nick, org].filter(Boolean).join(' · ');
        if (subText) rowSub.textContent = subText;
        else rowSub.hidden = true;
        body.append(name, rowSub);
        li.append(avatar, body);
        li.addEventListener('click', () => showContact(c, group));
        members.append(li);
      }
      blocks.push(members);
    }

    detailPane.append(...blocks);
  }

  function renderList() {
    list.replaceChildren();
    const items = filtered(search.value);
    status.hidden = true;
    if (!items.length) {
      status.hidden = false;
      status.textContent = groups.length ? 'No matches.' : 'No groups yet.';
      return;
    }

    /** @type {string | null} */
    let lastKind = null;
    for (const g of items) {
      const kind = groupKindLabel(g);
      if (kind !== lastKind) {
        lastKind = kind;
        const heading = document.createElement('li');
        heading.className = 'mobile-groups__heading';
        heading.textContent = kind === 'Event' ? 'Events' : 'Communities';
        list.append(heading);
      }
      const li = document.createElement('li');
      li.className = 'mobile-network__row';
      const body = document.createElement('div');
      body.className = 'mobile-network__row-body';
      const name = document.createElement('div');
      name.className = 'mobile-network__row-name';
      name.textContent = groupName(g);
      const sub = document.createElement('div');
      sub.className = 'mobile-network__row-sub';
      const n = memberCount(g);
      sub.textContent = `${n} member${n === 1 ? '' : 's'}`;
      body.append(name, sub);
      li.append(body);
      li.addEventListener('click', () => showGroup(g));
      list.append(li);
    }
  }

  search.addEventListener('input', () => {
    if (view !== 'list') return;
    renderList();
  });

  async function load() {
    try {
      const [groupsRes, contactsRes] = await Promise.all([
        fetch('/api/network/groups', { cache: 'no-store' }),
        fetch('/api/network/contacts', { cache: 'no-store' }),
      ]);
      const groupsData = await groupsRes.json().catch(() => ({}));
      const contactsData = await contactsRes.json().catch(() => ({}));
      if (!groupsRes.ok || groupsData.ok === false) {
        throw new Error(groupsData.error || `Groups HTTP ${groupsRes.status}`);
      }
      if (!contactsRes.ok || contactsData.ok === false) {
        throw new Error(contactsData.error || `Contacts HTTP ${contactsRes.status}`);
      }
      groups = Array.isArray(groupsData.groups) ? groupsData.groups.slice() : [];
      contactMap = new Map();
      for (const c of Array.isArray(contactsData.contacts) ? contactsData.contacts : []) {
        if (c?.id) contactMap.set(String(c.id), c);
      }
      renderList();
    } catch (e) {
      status.hidden = false;
      status.textContent = `Could not load groups: ${e?.message || e}`;
    }
  }

  void load();
}
