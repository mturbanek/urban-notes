'use strict';

// ── API ───────────────────────────────────────────────────────────────────────
const api = {
  async getNotes() {
    const r = await fetch('/api/notes');
    if (!r.ok) throw new Error('Failed to load notes');
    return r.json();
  },
  async createNote(note) {
    const r = await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(note),
    });
    if (!r.ok) throw new Error('Failed to create note');
    return r.json();
  },
  async updateNote(id, note) {
    const r = await fetch(`/api/notes/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(note),
    });
    if (!r.ok) throw new Error('Failed to save note');
    return r.json();
  },
  async deleteNote(id) {
    const r = await fetch(`/api/notes/${id}`, { method: 'DELETE' });
    if (!r.ok) throw new Error('Failed to delete note');
  },
  async render(content) {
    const r = await fetch('/api/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!r.ok) throw new Error('Render failed');
    const d = await r.json();
    return d.html;
  },
};

// ── State ─────────────────────────────────────────────────────────────────────
let notes      = [];
let currentId  = null;
let currentTags = [];
let saveTimer  = null;
let easyMDE    = null;
let ignoreChange = false;
let isEditing  = false;
let activeTagFilter = null;
let sidebarOpen = false;

// Calendar state
let calendarYear   = new Date().getFullYear();
let calendarMonth  = new Date().getMonth(); // 0-indexed
let calendarFilter = null; // { year, month, day } or null
let calendarOpen   = false;

// Tags sidebar section state
let tagsOpen = false;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const welcomeScreen = $('welcomeScreen');
const editorScreen  = $('editorScreen');
const notesList     = $('notesList');
const titleInput    = $('titleInput');
const saveStatus    = $('saveStatus');
const noteView      = $('noteView');
const editBtn       = $('editBtn');
const doneBtn       = $('doneBtn');
const searchInput   = $('searchInput');
const tagFilters    = $('tagFilters');
const tagPills      = $('tagPills');
const tagInput      = $('tagInput');

// ── Mobile sidebar ───────────────────────────────────────────────────────────
function isMobile() { return window.innerWidth <= 768; }

function openSidebar() {
  sidebarOpen = true;
  $('sidebar').classList.add('mobile-open');
  const ov = $('sidebarOverlay');
  ov.style.display = 'block';
  // Force reflow before adding visible so transition plays
  ov.offsetHeight; // eslint-disable-line no-unused-expressions
  ov.classList.add('visible');
}

function closeSidebar() {
  sidebarOpen = false;
  $('sidebar').classList.remove('mobile-open');
  const ov = $('sidebarOverlay');
  ov.classList.remove('visible');
  // Hide after transition
  setTimeout(() => { if (!sidebarOpen) ov.style.display = ''; }, 280);
}

function toggleSidebar() {
  sidebarOpen ? closeSidebar() : openSidebar();
}

// ── Theme ─────────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('theme', theme);
  $('hljs-light').disabled = (theme === 'dark');
  $('hljs-dark').disabled  = (theme === 'light');
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme;
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

// Apply correct hljs stylesheet on load
function initTheme() {
  const theme = document.documentElement.dataset.theme || 'light';
  $('hljs-light').disabled = (theme === 'dark');
  $('hljs-dark').disabled  = (theme !== 'dark');
}

// ── Tag colors ────────────────────────────────────────────────────────────────
const TAG_PALETTE = [
  { bg: 'rgba(99,102,241,.15)',  text: '#6366f1' },
  { bg: 'rgba(139,92,246,.15)', text: '#8b5cf6' },
  { bg: 'rgba(236,72,153,.15)', text: '#ec4899' },
  { bg: 'rgba(239,68,68,.15)',  text: '#ef4444' },
  { bg: 'rgba(249,115,22,.15)', text: '#f97316' },
  { bg: 'rgba(234,179,8,.15)',  text: '#b45309' },
  { bg: 'rgba(34,197,94,.15)',  text: '#16a34a' },
  { bg: 'rgba(20,184,166,.15)', text: '#0d9488' },
  { bg: 'rgba(59,130,246,.15)', text: '#2563eb' },
  { bg: 'rgba(6,182,212,.15)',  text: '#0891b2' },
];

function tagColor(tag) {
  let h = 0;
  for (const c of tag) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0;
  return TAG_PALETTE[Math.abs(h) % TAG_PALETTE.length];
}

function renderTagPill(tag, editable = false) {
  const c = tagColor(tag);
  const removeBtn = editable
    ? `<button class="tag-pill-remove" data-tag="${escapeHtml(tag)}" title="Remove tag" aria-label="Remove ${escapeHtml(tag)}">×</button>`
    : '';
  return `<span class="tag-pill${editable ? ' editable' : ''}"
    style="background:${c.bg};color:${c.text}"
    data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}${removeBtn}</span>`;
}

function renderTagBadge(tag) {
  const c = tagColor(tag);
  return `<span class="note-item-tag" style="background:${c.bg};color:${c.text}">${escapeHtml(tag)}</span>`;
}

// ── Tag bar UI ────────────────────────────────────────────────────────────────
function renderTagBar(editable = false) {
  tagPills.innerHTML = currentTags.map(t => renderTagPill(t, editable)).join('');
  tagInput.style.display = editable ? '' : 'none';

  // Remove buttons
  tagPills.querySelectorAll('.tag-pill-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      removeTag(btn.dataset.tag);
    });
  });
}

function addTag(raw) {
  const tag = raw.trim().toLowerCase().replace(/^#+/, '').replace(/[,\s]+/g, '-').replace(/[^a-z0-9_-]/g, '');
  if (!tag || currentTags.includes(tag)) return;
  currentTags = [...currentTags, tag];
  renderTagBar(isEditing);
  const newPill = tagPills.querySelector(`[data-tag="${tag}"]`);
  if (newPill) {
    newPill.classList.add('tag-pill-new');
    newPill.addEventListener('animationend', () => newPill.classList.remove('tag-pill-new'), { once: true });
  }
  scheduleSave();
  updateTagFilters();
}

function removeTag(tag) {
  currentTags = currentTags.filter(t => t !== tag);
  renderTagBar(isEditing);
  scheduleSave();
  updateTagFilters();
}

// ── Sidebar tag filters ───────────────────────────────────────────────────────
function allTags() {
  const set = new Set();
  notes.forEach(n => (n.tags || []).forEach(t => set.add(t)));
  return [...set].sort();
}

function updateTagFilters() {
  const tags = allTags();
  const section = $('tagsSection');
  const toggle  = $('tagsToggle');

  if (tags.length === 0) {
    section.classList.add('hidden');
    tagFilters.classList.remove('open');
    return;
  }

  section.classList.remove('hidden');

  if (tagsOpen) {
    toggle.classList.add('open');
    tagFilters.classList.add('open');
    tagFilters.innerHTML = tags.map(t => {
      const c = tagColor(t);
      return `<span class="tag-filter-pill${activeTagFilter === t ? ' active' : ''}"
        style="background:${c.bg};color:${c.text}"
        data-tag="${escapeHtml(t)}">${escapeHtml(t)}</span>`;
    }).join('') + (activeTagFilter ? `<span class="tag-filter-clear">✕ clear</span>` : '');

    tagFilters.querySelectorAll('.tag-filter-pill').forEach(el => {
      el.addEventListener('click', () => {
        activeTagFilter = activeTagFilter === el.dataset.tag ? null : el.dataset.tag;
        updateTagFilters();
        renderList(searchInput.value);
      });
    });
    const clr = tagFilters.querySelector('.tag-filter-clear');
    if (clr) clr.addEventListener('click', () => { activeTagFilter = null; updateTagFilters(); renderList(searchInput.value); });
  } else {
    toggle.classList.remove('open');
    tagFilters.classList.remove('open');
  }
}

function toggleTags() {
  tagsOpen = !tagsOpen;
  updateTagFilters();
}

// ── Wiki-link processing ──────────────────────────────────────────────────────
function processWikiLinks(html) {
  // Split on <pre> and <code> blocks so [[links]] inside fenced code are left alone.
  // Odd-indexed parts are the matched blocks — pass them through unchanged.
  const parts = html.split(/(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>)/i);
  return parts.map((part, i) => {
    if (i % 2 === 1) return part;
    return part.replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_, title, alias) => {
      const display = alias || title;
      const note = notes.find(n => n.title.trim().toLowerCase() === title.trim().toLowerCase());
      if (note) {
        return `<a class="wiki-link" data-note-id="${note.id}" href="#">${escapeHtml(display)}</a>`;
      }
      return `<span class="wiki-link-missing" title="Note not found: ${escapeHtml(title)}">[[${escapeHtml(display)}]]</span>`;
    });
  }).join('');
}

// ── Calendar ──────────────────────────────────────────────────────────────────
function noteDateKey(dateStr) {
  const d = new Date(dateStr);
  // Month is 0-indexed intentionally — renderCalendar builds keys the same way.
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function noteDatesSet() {
  const set = new Set();
  for (const n of notes) {
    if (n.modified) set.add(noteDateKey(n.modified));
  }
  return set;
}

function renderCalendar() {
  const container = $('calendarContainer');
  const toggle    = $('calendarToggle');
  if (!calendarOpen) {
    container.classList.remove('open');
    toggle.classList.remove('open');
    return;
  }
  container.classList.add('open');
  toggle.classList.add('open');

  const datesWithNotes = noteDatesSet();
  const today = new Date();
  const firstDay  = new Date(calendarYear, calendarMonth, 1);
  const lastDay   = new Date(calendarYear, calendarMonth + 1, 0);
  const startDow  = firstDay.getDay();
  const totalDays = lastDay.getDate();

  const monthLabel = firstDay.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const dayHeaders = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  let cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= totalDays; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  container.innerHTML = `
    <div class="calendar-header">
      <button class="cal-nav" id="calPrev" title="Previous month">‹</button>
      <span class="cal-month-label">${monthLabel}</span>
      <button class="cal-nav" id="calNext" title="Next month">›</button>
    </div>
    <div class="calendar-grid">
      ${dayHeaders.map(d => `<div class="cal-dow">${d}</div>`).join('')}
      ${cells.map(day => {
        if (!day) return '<div class="cal-day"></div>';
        const key      = `${calendarYear}-${calendarMonth}-${day}`;
        const isToday  = today.getFullYear() === calendarYear && today.getMonth() === calendarMonth && today.getDate() === day;
        const hasNotes = datesWithNotes.has(key);
        const isActive = calendarFilter && calendarFilter.year === calendarYear && calendarFilter.month === calendarMonth && calendarFilter.day === day;
        const cls = ['cal-day', isToday ? 'today' : '', hasNotes ? 'has-notes' : '', isActive ? 'active' : ''].filter(Boolean).join(' ');
        return `<div class="${cls}" data-day="${day}">${day}</div>`;
      }).join('')}
    </div>
    ${calendarFilter ? '<div class="cal-clear-row"><button class="cal-clear-btn" id="calClear">✕ clear</button></div>' : ''}
  `;

  $('calPrev').addEventListener('click', () => {
    calendarMonth--;
    if (calendarMonth < 0) { calendarMonth = 11; calendarYear--; }
    renderCalendar();
  });
  $('calNext').addEventListener('click', () => {
    calendarMonth++;
    if (calendarMonth > 11) { calendarMonth = 0; calendarYear++; }
    renderCalendar();
  });

  container.querySelectorAll('.cal-day[data-day]').forEach(el => {
    el.addEventListener('click', () => {
      const day = parseInt(el.dataset.day);
      const sameDay = calendarFilter && calendarFilter.year === calendarYear && calendarFilter.month === calendarMonth && calendarFilter.day === day;
      calendarFilter = sameDay ? null : { year: calendarYear, month: calendarMonth, day };
      renderCalendar();
      renderList(searchInput.value);
    });
  });

  const clr = $('calClear');
  if (clr) clr.addEventListener('click', () => {
    calendarFilter = null;
    renderCalendar();
    renderList(searchInput.value);
  });
}

function toggleCalendar() {
  calendarOpen = !calendarOpen;
  renderCalendar();
}

// ── Utility ───────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000), h = Math.floor(diff / 3600000), d = Math.floor(diff / 86400000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (d < 7)  return `${d}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function makeSnippet(content, len = 72) {
  if (!content) return '';
  const s = content
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/!\[.*?\]\(.*?\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t, a) => a || t)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>`-]+/g, '')
    .replace(/\s+/g, ' ').trim();
  return s.length > len ? s.slice(0, len) + '…' : s;
}

// ── Save status ───────────────────────────────────────────────────────────────
function setSaveStatus(state, text) {
  saveStatus.textContent = text;
  saveStatus.className = `save-status ${state}`;
}

// ── Notes list ────────────────────────────────────────────────────────────────
function renderList(filter = '') {
  const q = filter.toLowerCase().trim();
  let visible = notes;
  if (activeTagFilter) visible = visible.filter(n => (n.tags || []).includes(activeTagFilter));
  if (calendarFilter) {
    visible = visible.filter(n => {
      if (!n.modified) return false;
      const d = new Date(n.modified);
      return d.getFullYear() === calendarFilter.year && d.getMonth() === calendarFilter.month && d.getDate() === calendarFilter.day;
    });
  }
  if (q) visible = visible.filter(n => n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q) || (n.tags||[]).some(t=>t.includes(q)));

  if (visible.length === 0) {
    let emptyMsg;
    if (calendarFilter) {
      const d = new Date(calendarFilter.year, calendarFilter.month, calendarFilter.day);
      const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      emptyMsg = `No notes modified on ${dateStr}.`;
    } else if (q || activeTagFilter) {
      emptyMsg = 'No matching notes.';
    } else {
      emptyMsg = `No notes yet.<br>Click <strong>New Note</strong> to start.`;
    }
    notesList.innerHTML = `<div class="notes-empty">${emptyMsg}</div>`;
    return;
  }

  notesList.innerHTML = visible.map(n => {
    const tags = (n.tags || []).slice(0, 3).map(renderTagBadge).join('');
    const hasTags = n.tags && n.tags.length > 0;
    return `<div class="note-item${n.id === currentId ? ' active' : ''}" data-id="${n.id}">
      <div class="note-item-title">${escapeHtml(n.title)}</div>
      ${hasTags ? `<div class="note-item-tags">${tags}</div>` : ''}
      <div class="note-item-snippet">${escapeHtml(makeSnippet(n.content))}</div>
      <div class="note-item-date">${timeAgo(n.modified)}</div>
    </div>`;
  }).join('');

  notesList.querySelectorAll('.note-item').forEach(el =>
    el.addEventListener('click', () => selectNote(el.dataset.id)));
  staggerNoteItems();
}

// ── View / Edit modes ─────────────────────────────────────────────────────────
async function showViewMode() {
  // Claim a render slot. If showEditMode() or another showViewMode() fires while
  // we are awaiting, our seq will be stale and we must abort before touching the DOM.
  const seq = ++_viewSeq;
  const id = currentId;

  isEditing = false;
  titleInput.readOnly = true;
  tagInput.style.display = 'none';
  editBtn.classList.remove('hidden');
  doneBtn.classList.add('hidden');

  renderTagBar(false);

  const note = notes.find(n => n.id === id);

  // Populate timestamp metadata bar
  const noteMeta = $('noteMeta');
  if (note && noteMeta) {
    const parts = [];
    if (note.created) {
      const createdStr = new Date(note.created).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      parts.push(`Created ${createdStr}`);
    }
    if (note.modified) {
      parts.push(`Modified ${timeAgo(note.modified)}`);
    }
    if (parts.length) {
      noteMeta.innerHTML = parts.join('<span class="note-meta-sep"> · </span>');
      noteMeta.classList.remove('hidden');
    } else {
      noteMeta.classList.add('hidden');
    }
  }

  const content = note?.content || '';

  if (content.trim()) {
    try {
      let html = await api.render(content);
      if (seq !== _viewSeq || currentId !== id) return;
      html = processWikiLinks(html);
      noteView.innerHTML = `<div class="note-view-inner">${html}</div>`;
      const inner = noteView.querySelector('.note-view-inner');
      inner.querySelectorAll('pre code').forEach(el => hljs.highlightElement(el));
      inner.querySelectorAll('.wiki-link[data-note-id]').forEach(el => {
        el.addEventListener('click', e => { e.preventDefault(); selectNote(el.dataset.noteId); });
      });
      const tocEl = buildToc(inner);
      if (tocEl) inner.prepend(tocEl);
      const curNote = notes.find(n => n.id === id);
      if (curNote) {
        const blEl = buildBacklinks(id, curNote.title);
        if (blEl) inner.appendChild(blEl);
      }
    } catch {
      if (seq !== _viewSeq || currentId !== id) return;
      noteView.innerHTML = `<div class="note-view-inner"><p class="note-view-empty">Could not render preview.</p></div>`;
    }
  } else {
    noteView.innerHTML = `<div class="note-view-inner"><p class="note-view-empty">This note is empty. Click <strong>Edit</strong> to start writing.</p></div>`;
  }

  if (seq !== _viewSeq || currentId !== id) return;
  noteView.classList.remove('hidden');
  $('editorContainer').classList.add('hidden');
}

function showEditMode() {
  ++_viewSeq; // abort any in-flight showViewMode for this note
  isEditing = true;
  titleInput.readOnly = false;
  editBtn.classList.add('hidden');
  doneBtn.classList.remove('hidden');
  $('noteMeta').classList.add('hidden');

  renderTagBar(true);
  tagInput.style.display = '';

  noteView.classList.add('hidden');
  $('editorContainer').classList.remove('hidden');

  // Load content NOW while the container is visible so CodeMirror renders
  // with correct dimensions in a single pass. Loading while hidden forces a
  // second full render when the container is shown, which is the source of delay.
  const note = notes.find(n => n.id === currentId);
  ignoreChange = true;
  easyMDE.value(note?.content || '');
  setTimeout(() => { ignoreChange = false; }, 0);

  easyMDE.codemirror.refresh();
  easyMDE.codemirror.focus();
}

// ── Select a note ─────────────────────────────────────────────────────────────
let _selectSeq = 0; // incremented on every selectNote call; stale calls self-abort
let _viewSeq   = 0; // incremented on every showViewMode call; aborts stale renders

async function selectNote(id) {
  const note = notes.find(n => n.id === id);
  if (!note) return;

  const seq = ++_selectSeq; // claim this as the latest in-flight selection

  clearTimeout(saveTimer); // always cancel pending auto-save before switching
  if (currentId && currentId !== id && isEditing) {
    await doSave();
  }

  // Another selectNote started while we were saving — bail out
  if (seq !== _selectSeq) return;

  currentId = id;
  currentTags = [...(note.tags || [])];

  // Only update the title input here; editor content is loaded lazily in
  // showEditMode() so we never call easyMDE.value() on a hidden container
  // (which forces an expensive re-render when the container is later shown).
  titleInput.value = note.title;

  setSaveStatus('', '');
  stopParticles();
  welcomeScreen.classList.add('hidden');
  editorScreen.classList.remove('hidden');
  renderList(searchInput.value);

  // On mobile, close the sidebar drawer so the note content is visible
  if (isMobile()) closeSidebar();

  await showViewMode();
}

// ── Auto-save ─────────────────────────────────────────────────────────────────
function scheduleSave() {
  if (ignoreChange || !currentId) return;
  setSaveStatus('saving', 'Unsaved…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 1500);
}

async function doSave() {
  if (!currentId) return;
  const id = currentId; // capture before async ops — currentId may change while awaiting
  try {
    const updated = await api.updateNote(id, {
      title:   titleInput.value.trim() || 'Untitled Note',
      content: easyMDE.value(),
      tags:    currentTags,
    });
    const idx = notes.findIndex(n => n.id === id);
    if (idx !== -1) notes[idx] = updated;
    setSaveStatus('saved', 'Saved');
    renderList(searchInput.value);
    updateTagFilters();
    renderCalendar();
    setTimeout(() => { if (saveStatus.classList.contains('saved')) setSaveStatus('', ''); }, 2500);
  } catch (e) {
    console.error('Save failed:', e);
    setSaveStatus('error', 'Save failed');
  }
}

// ── New note ──────────────────────────────────────────────────────────────────
async function createNote() {
  try {
    const note = await api.createNote({ title: 'Untitled Note', content: '', tags: [] });
    notes.unshift(note);
    renderList(searchInput.value);
    renderCalendar();
    await selectNote(note.id); // also closes sidebar on mobile
    showEditMode();
    setTimeout(() => titleInput.select(), 50);
  } catch (e) {
    alert('Failed to create note: ' + e.message);
  }
}

// ── Welcome screen ────────────────────────────────────────────────────────────
function showWelcomeScreen() {
  clearTimeout(saveTimer);
  currentId = null;
  currentTags = [];
  isEditing = false;
  welcomeScreen.classList.remove('hidden');
  editorScreen.classList.add('hidden');
  renderList(searchInput.value);
  startParticles();
  if (isMobile()) openSidebar();
}

// ── Delete note ───────────────────────────────────────────────────────────────
async function deleteCurrentNote() {
  if (!currentId) return;
  const note = notes.find(n => n.id === currentId);
  if (!confirm(`Delete "${note?.title || 'this note'}"?`)) return;
  try {
    await api.deleteNote(currentId);
    notes = notes.filter(n => n.id !== currentId);
    renderList(searchInput.value);
    updateTagFilters();
    renderCalendar();
    showWelcomeScreen();
  } catch (e) {
    alert('Failed to delete note: ' + e.message);
  }
}

// ── Note-link picker ──────────────────────────────────────────────────────────
let noteLinkPickerOpen = false;

function openNoteLinkPicker() {
  noteLinkPickerOpen = true;
  const picker = $('noteLinkPicker');
  picker.classList.remove('hidden');
  const search = $('noteLinkSearch');
  search.value = '';
  renderPickerResults('');
  search.focus();
}

function closeNoteLinkPicker() {
  noteLinkPickerOpen = false;
  $('noteLinkPicker').classList.add('hidden');
  easyMDE.codemirror.focus();
}

function renderPickerResults(q) {
  const results = $('noteLinkResults');
  const filtered = q
    ? notes.filter(n => n.id !== currentId && n.title.toLowerCase().includes(q.toLowerCase()))
    : notes.filter(n => n.id !== currentId);

  if (filtered.length === 0) {
    results.innerHTML = `<div class="nlp-empty">No notes found</div>`;
    return;
  }
  results.innerHTML = filtered.map(n => {
    const tags = (n.tags || []).map(t => {
      const c = tagColor(t);
      return `<span class="note-item-tag" style="background:${c.bg};color:${c.text}">${escapeHtml(t)}</span>`;
    }).join('');
    return `<div class="nlp-item" data-id="${n.id}" data-title="${escapeHtml(n.title)}">
      <div class="nlp-item-title">${escapeHtml(n.title)}</div>
      ${tags ? `<div class="nlp-item-tags">${tags}</div>` : ''}
    </div>`;
  }).join('');

  results.querySelectorAll('.nlp-item').forEach(el => {
    el.addEventListener('click', () => {
      insertWikiLink(el.dataset.title);
      closeNoteLinkPicker();
    });
  });
}

function insertWikiLink(title) {
  const cm = easyMDE.codemirror;
  const cursor = cm.getCursor();
  cm.replaceRange(`[[${title}]]`, cursor);
  cm.focus();
}

// ── Tips modal ────────────────────────────────────────────────────────────────
function openTips()  { $('tipsModal').classList.remove('hidden'); }
function closeTips() { $('tipsModal').classList.add('hidden'); }

// ── EasyMDE ───────────────────────────────────────────────────────────────────
function initEditor() {
  easyMDE = new EasyMDE({
    element: $('mdEditor'),
    autofocus: false,
    autosave: { enabled: false },
    spellChecker: false,
    inputStyle: 'contenteditable',
    nativeSpellcheck: true,
    sideBySideFullscreen: false,
    toolbar: [
      'bold', 'italic', 'strikethrough', 'heading', '|',
      'quote', 'unordered-list', 'ordered-list', '|',
      'link', 'image', '|',
      'code', 'table', '|',
      {
        name: 'note-link',
        action: openNoteLinkPicker,
        className: 'fa fa-link',
        title: 'Link to Note ([[Title]])',
      },
      '|',
      'side-by-side', 'fullscreen', '|',
      {
        name: 'tips',
        action: openTips,
        className: 'fa fa-question-circle',
        title: 'Markdown Tips',
      },
    ],
    placeholder: 'Start writing in Markdown…\n\nLink to notes with [[Note Title]]\nAdd tags in the tag bar above.',
    imageUploadFunction(file, onSuccess, onError) {
      const fd = new FormData();
      fd.append('image', file);
      fetch('/api/upload', { method: 'POST', body: fd })
        .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
        .then(d => onSuccess(d.url))
        .catch(err => onError('Upload failed: ' + err));
    },
    renderingConfig: { codeSyntaxHighlighting: true },
    status: ['lines', 'words', 'cursor'],
    previewClass: ['editor-preview'],
  });

  easyMDE.codemirror.on('change', scheduleSave);
}

// ── Export ────────────────────────────────────────────────────────────────────
function safeFilename(title) {
  return (title || 'untitled').replace(/[/\\:*?"<>|]/g, '-').replace(/\s+/g, '_').slice(0, 80);
}

function buildExportHtml(title, bodyHtml) {
  const dark = document.documentElement.dataset.theme === 'dark';
  const hljsSheet = dark
    ? 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css'
    : 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${hljsSheet}">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"><\/script>
<style>
body{font-family:system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.8;color:#0f0e13;background:#faf9f7;max-width:740px;margin:40px auto;padding:0 24px 80px}
h1,h2,h3,h4{font-weight:700;letter-spacing:-.02em;margin-top:1.8em;margin-bottom:.45em}
h1{font-size:2.1em;margin-top:.2em}h2{font-size:1.45em;border-bottom:1px solid #e9e5df;padding-bottom:.3em}h3{font-size:1.2em}
a{color:#7c3aed;text-decoration:underline}
code{font-family:'JetBrains Mono',monospace;font-size:.87em;background:#edeae5;padding:0 4px;border-radius:4px}
pre code{background:transparent;padding:0}
pre{background:#edeae5;border-radius:8px;padding:14px 16px;overflow-x:auto;margin:1em 0}
blockquote{border-left:3px solid #a78bfa;margin:.8em 0;padding:.2em 0 .2em 16px;color:#6b6779}
table{border-collapse:collapse;width:100%;margin:1em 0}
th,td{border:1px solid #dbd7d0;padding:6px 12px;text-align:left}
th{background:#f3f1ee;font-weight:600}
img{max-width:100%}
ul,ol{padding-left:1.5em;margin:.5em 0}
li{margin:.2em 0}
@media print{body{margin:0;padding:20px;max-width:none}pre{white-space:pre-wrap}}
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${bodyHtml}
<script>document.addEventListener('DOMContentLoaded',()=>hljs.highlightAll());<\/script>
</body>
</html>`;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function exportNote(fmt) {
  if (!currentId) return;
  const note = notes.find(n => n.id === currentId);
  if (!note) return;
  const filename = safeFilename(note.title);

  if (fmt === 'md') {
    triggerDownload(new Blob([note.content || ''], { type: 'text/markdown' }), filename + '.md');
    return;
  }

  let html;
  try {
    html = processWikiLinks(await api.render(note.content || ''));
  } catch {
    alert('Could not render note for export.');
    return;
  }

  if (fmt === 'html') {
    triggerDownload(new Blob([buildExportHtml(note.title, html)], { type: 'text/html' }), filename + '.html');
    return;
  }

  if (fmt === 'pdf') {
    // Open synchronously before any await so popup blockers don't fire.
    const win = window.open('', '_blank');
    if (!win) { alert('Allow pop-ups to export as PDF.'); return; }
    win.document.write(buildExportHtml(note.title, html));
    win.document.close();
    win.addEventListener('load', () => { win.focus(); win.print(); });
    win.addEventListener('afterprint', () => win.close());
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function init() {
  initTheme();
  initEditor();
  initSlashCommands();
  initWhimsy();

  // Brand click → welcome screen (ignore clicks on the theme toggle button inside it)
  document.querySelector('.sidebar-brand').addEventListener('click', e => {
    if (e.target.closest('#themeToggle')) return;
    showWelcomeScreen();
  });

  // Theme toggle
  $('themeToggle').addEventListener('click', toggleTheme);

  // Sidebar drawer (mobile)
  $('sidebarToggle').addEventListener('click', toggleSidebar);
  $('welcomeSidebarToggle').addEventListener('click', toggleSidebar);
  $('sidebarOverlay').addEventListener('click', closeSidebar);

  // Calendar
  $('calendarToggle').addEventListener('click', toggleCalendar);

  // Tags section
  $('tagsToggle').addEventListener('click', toggleTags);

  // Note graph
  $('graphBtn').addEventListener('click', openGraph);
  $('graphClose').addEventListener('click', closeGraph);
  _initGraphEvents($('graphCanvas'));

  // New / welcome
  $('newNoteBtn').addEventListener('click', createNote);
  $('welcomeNewBtn').addEventListener('click', createNote);
  $('welcomeTipsBtn').addEventListener('click', openTips);

  // Edit / done
  editBtn.addEventListener('click', showEditMode);
  doneBtn.addEventListener('click', async () => { clearTimeout(saveTimer); await doSave(); await showViewMode(); });

  // Double-click rendered view → edit
  noteView.addEventListener('dblclick', showEditMode);

  // Tips
  $('tipsBtn').addEventListener('click', openTips);
  $('closeTips').addEventListener('click', closeTips);
  $('tipsModal').addEventListener('click', e => { if (e.target === $('tipsModal')) closeTips(); });

  // Export dropdown
  const exportMenu = $('exportMenu');
  $('exportBtn').addEventListener('click', e => {
    e.stopPropagation();
    exportMenu.classList.toggle('hidden');
  });
  exportMenu.querySelectorAll('.export-item').forEach(el => {
    el.addEventListener('click', () => {
      exportMenu.classList.add('hidden');
      exportNote(el.dataset.fmt);
    });
  });
  document.addEventListener('click', () => exportMenu.classList.add('hidden'));

  // Delete
  $('deleteBtn').addEventListener('click', deleteCurrentNote);

  // Search
  searchInput.addEventListener('input', () => renderList(searchInput.value));

  // Tag bar
  tagInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(tagInput.value);
      tagInput.value = '';
    } else if (e.key === 'Backspace' && tagInput.value === '' && currentTags.length > 0) {
      removeTag(currentTags[currentTags.length - 1]);
    }
  });
  tagInput.addEventListener('blur', () => {
    if (tagInput.value.trim()) { addTag(tagInput.value); tagInput.value = ''; }
  });

  // Note-link picker
  $('noteLinkSearch').addEventListener('input', e => renderPickerResults(e.target.value));
  $('noteLinkSearch').addEventListener('keydown', e => { if (e.key === 'Escape') closeNoteLinkPicker(); });
  $('noteLinkClose').addEventListener('click', closeNoteLinkPicker);

  // Global shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (_gOpen) { closeGraph(); return; }
      if (!$('tipsModal').classList.contains('hidden')) { closeTips(); return; }
      if (noteLinkPickerOpen) { closeNoteLinkPicker(); return; }
      if (isEditing) { clearTimeout(saveTimer); doSave().then(showViewMode); }
    }
    if (e.key === 'g' && !e.ctrlKey && !e.metaKey && !isEditing && !_gOpen &&
        document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
      openGraph(); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      clearTimeout(saveTimer);
      doSave().then(() => { if (isEditing) showViewMode(); });
    }
  });

  // Title changes
  titleInput.addEventListener('input', scheduleSave);
  titleInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); tagInput.focus(); }
  });

  // Display build version in sidebar footer
  fetch('/api/version').then(r => r.json()).then(d => {
    const el = $('appVersion');
    if (el) el.textContent = d.version;
  }).catch(() => {});

  // Load notes
  try {
    notes = await api.getNotes();
    renderList();
    updateTagFilters();
    renderCalendar();
    if (notes.length > 0) {
      if (isMobile()) {
        // On mobile, show the notes list first (sidebar open), don't auto-open a note
        openSidebar();
        welcomeScreen.classList.remove('hidden');
        editorScreen.classList.add('hidden');
        startParticles();
      } else {
        await selectNote(notes[0].id);
      }
    } else {
      welcomeScreen.classList.remove('hidden');
      editorScreen.classList.add('hidden');
      if (isMobile()) openSidebar();
      startParticles();
    }
  } catch {
    notesList.innerHTML = '<div class="notes-empty">Could not load notes.</div>';
  }
}

// ── Rich rendering — ToC, Backlinks ──────────────────────────────────────────

function buildToc(container) {
  const hs = [...container.querySelectorAll('h1,h2,h3,h4')];
  if (hs.length < 2) return null;

  const nav = document.createElement('nav');
  nav.className = 'note-toc';

  const label = document.createElement('div');
  label.className = 'note-toc-title';
  label.textContent = 'Contents';
  nav.appendChild(label);

  const ol = document.createElement('ol');
  ol.className = 'note-toc-list';
  hs.forEach(h => {
    const li = document.createElement('li');
    li.className = `toc-item toc-${h.tagName.toLowerCase()}`;
    const a = document.createElement('a');
    a.textContent = h.textContent;
    a.href = '#';
    a.addEventListener('click', e => { e.preventDefault(); h.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    li.appendChild(a);
    ol.appendChild(li);
  });
  nav.appendChild(ol);
  return nav;
}

function buildBacklinks(noteId, noteTitle) {
  const targetLower = noteTitle.trim().toLowerCase();
  const wikiRe = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  const sources = notes.filter(n => {
    if (n.id === noteId || !n.content) return false;
    return [...n.content.matchAll(wikiRe)].some(m => m[1].trim().toLowerCase() === targetLower);
  });
  if (sources.length === 0) return null;

  const section = document.createElement('div');
  section.className = 'backlinks-section';
  section.innerHTML = `
    <div class="backlinks-header">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
      </svg>
      Linked from <span class="backlinks-count">${sources.length}</span>
    </div>
    <div class="backlinks-list">
      ${sources.map(n => `<div class="backlink-item" data-id="${n.id}">
        <div class="backlink-title">${escapeHtml(n.title)}</div>
        <div class="backlink-snippet">${escapeHtml(makeSnippet(n.content, 90))}</div>
      </div>`).join('')}
    </div>`;
  section.querySelectorAll('.backlink-item').forEach(el =>
    el.addEventListener('click', () => selectNote(el.dataset.id)));
  return section;
}

// ── Slash Commands ────────────────────────────────────────────────────────────

const SLASH_COMMANDS = [
  { id:'h1',      icon:'H1',   label:'Heading 1',     desc:'Large section heading',      text:'# ',              replaceLine:true },
  { id:'h2',      icon:'H2',   label:'Heading 2',     desc:'Medium section heading',     text:'## ',             replaceLine:true },
  { id:'h3',      icon:'H3',   label:'Heading 3',     desc:'Small section heading',      text:'### ',            replaceLine:true },
  { id:'bold',    icon:'B',    label:'Bold',           desc:'**bold** text',              text:'**bold**',        sel:[2,6] },
  { id:'italic',  icon:'I',    label:'Italic',         desc:'*italic* text',              text:'*italic*',        sel:[1,7] },
  { id:'strike',  icon:'S̶',    label:'Strikethrough',  desc:'~~strike~~ text',            text:'~~text~~',        sel:[2,6] },
  { id:'ul',      icon:'•',    label:'Bullet list',    desc:'Unordered list item',        text:'- ',              replaceLine:true },
  { id:'ol',      icon:'1.',   label:'Numbered list',  desc:'Ordered list item',          text:'1. ',             replaceLine:true },
  { id:'todo',    icon:'☐',   label:'Task list',      desc:'Checkbox list item',         text:'- [ ] ',          replaceLine:true },
  { id:'quote',   icon:'❝',   label:'Quote',          desc:'Blockquote',                 text:'> ',              replaceLine:true },
  { id:'code',    icon:'</>',  label:'Code block',     desc:'Fenced code block',          text:'```\n\n```',      ml:true, mlCursor:1 },
  { id:'table',   icon:'⊞',   label:'Table',          desc:'Two-column table',           text:'| Col 1 | Col 2 |\n|---|---|\n| Cell | Cell |', ml:true, mlCursor:0 },
  { id:'divider', icon:'—',   label:'Divider',        desc:'Horizontal rule',            text:'---',             replaceLine:true },
  { id:'link',    icon:'[[',   label:'Note link',      desc:'Link to another note',       action:'noteLinkPicker' },
  { id:'image',   icon:'🖼',   label:'Image',          desc:'Upload an image file',        action:'imagePicker' },
];

let _slashActive = false;
let _slashAnchor = null; // { line, ch } of the slash char
let _slashIdx    = 0;
let _slashFilter = '';

function _filteredCmds() {
  if (!_slashFilter) return SLASH_COMMANDS;
  const q = _slashFilter.toLowerCase();
  return SLASH_COMMANDS.filter(c => c.label.toLowerCase().includes(q) || c.id.startsWith(q));
}

function initSlashCommands() {
  const cm = easyMDE.codemirror;

  cm.on('change', (_, ch) => {
    if (ch.origin === 'setValue' || ignoreChange) return;
    _checkSlash(cm);
  });

  cm.on('cursorActivity', () => {
    if (!_slashActive) return;
    if (cm.getCursor().line !== _slashAnchor?.line) _hideSlash();
  });

  // All palette navigation uses DOM capture so CM5 never sees these keys when
  // the palette is open — avoids keymap fall-through reliability issues entirely.
  cm.getWrapperElement().addEventListener('keydown', e => {
    if (!_slashActive) return;
    const f = _filteredCmds();
    if (e.key === 'ArrowDown') {
      e.preventDefault(); e.stopPropagation();
      _slashIdx = (_slashIdx + 1) % f.length;
      _renderSlash();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      _slashIdx = (_slashIdx - 1 + f.length) % f.length;
      _renderSlash();
    } else if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      if (f[_slashIdx]) _execSlash(f[_slashIdx]);
      else _hideSlash();
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      _hideSlash();
    } else if (e.key === 'Tab') {
      e.preventDefault(); e.stopPropagation();
      _slashIdx = (_slashIdx + 1) % f.length;
      _renderSlash();
    }
  }, true /* capture — fires before CodeMirror's own handlers */);
}

function _checkSlash(cm) {
  const cur = cm.getCursor();
  const before = cm.getLine(cur.line).slice(0, cur.ch);
  const m = before.match(/(^|\s)\/(\w*)$/);
  if (!m) { _hideSlash(); return; }
  _slashFilter = m[2];
  _slashAnchor = { line: cur.line, ch: cur.ch - 1 - m[2].length };
  _slashIdx = 0;
  const cmds = _filteredCmds();
  if (!cmds.length) { _hideSlash(); return; }
  _slashActive = true;
  const coords = cm.cursorCoords(cur, 'window');
  const pal = $('slashPalette');
  pal.classList.remove('hidden');
  const top = coords.bottom + 6;
  pal.style.top  = `${top + 300 > window.innerHeight ? coords.top - 316 : top}px`;
  pal.style.left = `${Math.min(coords.left, window.innerWidth - 288)}px`;
  _renderSlash();
}

function _renderSlash() {
  const cmds = _filteredCmds();
  const list = $('slashList');
  if (!cmds.length) { list.innerHTML = `<div class="slash-empty">No matches</div>`; return; }
  list.innerHTML = cmds.map((c, i) => `
    <div class="slash-item${i===_slashIdx?' sl-active':''}" data-i="${i}">
      <div class="slash-icon">${escapeHtml(c.icon)}</div>
      <div class="slash-item-body">
        <div class="slash-label">${escapeHtml(c.label)}</div>
        <div class="slash-desc">${escapeHtml(c.desc||'')}</div>
      </div>
    </div>`).join('');
  list.querySelectorAll('.slash-item').forEach(el =>
    el.addEventListener('mousedown', e => { e.preventDefault(); _execSlash(cmds[+el.dataset.i]); }));
  list.querySelector('.sl-active')?.scrollIntoView({ block:'nearest' });
}

function _hideSlash() {
  _slashActive = false; _slashAnchor = null;
  $('slashPalette').classList.add('hidden');
}

function _execSlash(cmd) {
  const cm = easyMDE.codemirror;
  const cur = cm.getCursor();
  const from = _slashAnchor || cur;
  _hideSlash();

  if (cmd.action === 'noteLinkPicker') {
    cm.replaceRange('', from, cur);
    openNoteLinkPicker(); return;
  }

  if (cmd.action === 'imagePicker') {
    cm.replaceRange('', from, cur);
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files[0];
      if (!file) { cm.focus(); return; }
      const fd = new FormData();
      fd.append('image', file);
      fetch('/api/upload', { method: 'POST', body: fd })
        .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
        .then(d => {
          const md = `![${file.name}](${d.url})`;
          cm.replaceRange(md, from);
          cm.setCursor({ line: from.line, ch: from.ch + md.length });
          cm.focus();
        })
        .catch(err => { alert('Upload failed: ' + err); cm.focus(); });
    };
    input.click();
    return;
  }

  if (cmd.replaceLine) {
    const line = cm.getLine(cur.line);
    cm.replaceRange(cmd.text, {line:cur.line,ch:0}, {line:cur.line,ch:line.length});
    cm.setCursor({line:cur.line, ch:cmd.text.length});
  } else if (cmd.ml) {
    cm.replaceRange(cmd.text, from, cur);
    const tl = cur.line + (cmd.mlCursor ?? 0);
    cm.setCursor({line:tl, ch:cm.getLine(tl)?.length||0});
  } else {
    cm.replaceRange(cmd.text, from, cur);
    if (cmd.sel) {
      cm.setSelection({line:cur.line,ch:from.ch+cmd.sel[0]},{line:cur.line,ch:from.ch+cmd.sel[1]});
    } else {
      cm.setCursor({line:cur.line, ch:from.ch+cmd.text.length});
    }
  }
  cm.focus();
}

// ── Note Graph ────────────────────────────────────────────────────────────────

let _gNodes = [], _gEdges = [], _gNodeMap = {};
let _gTransform = { x:0, y:0, scale:1 };
let _gRaf = null, _gOpen = false, _gSimulating = true;
let _gHovered = null, _gDragNode = null, _gDragStart = null, _gPan = null;
let _gTouchDist = null; // pinch-zoom baseline distance

function _nodeR(n) { return Math.min(46, 22 + n.degree * 3); }

function _buildGraph() {
  const wikiRe = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  _gNodes = notes.map(n => ({
    id:n.id, title:n.title,
    x:(Math.random()-.5)*500, y:(Math.random()-.5)*500,
    vx:0, vy:0, degree:0,
  }));
  _gNodeMap = {};
  _gNodes.forEach(n => _gNodeMap[n.id] = n);
  _gEdges = [];
  for (const n of notes) {
    if (!n.content) continue;
    for (const m of [...n.content.matchAll(wikiRe)]) {
      const title = m[1].trim().toLowerCase();
      const tgt = notes.find(t => t.title.trim().toLowerCase()===title);
      if (tgt && tgt.id!==n.id) {
        _gEdges.push({s:n.id, t:tgt.id});
        if (_gNodeMap[tgt.id]) _gNodeMap[tgt.id].degree++;
        if (_gNodeMap[n.id])   _gNodeMap[n.id].degree++;
      }
    }
  }
}

function _simStep() {
  const REP=9000, SPR=0.045, LEN=150, CTR=0.005, DAMP=0.8;
  for (let i=0;i<_gNodes.length;i++) {
    for (let j=i+1;j<_gNodes.length;j++) {
      const a=_gNodes[i], b=_gNodes[j];
      let dx=b.x-a.x, dy=b.y-a.y;
      const d2=dx*dx+dy*dy||0.1, d=Math.sqrt(d2), f=REP/d2;
      dx/=d; dy/=d;
      a.vx-=f*dx; a.vy-=f*dy; b.vx+=f*dx; b.vy+=f*dy;
    }
  }
  for (const e of _gEdges) {
    const a=_gNodeMap[e.s], b=_gNodeMap[e.t]; if(!a||!b) continue;
    let dx=b.x-a.x, dy=b.y-a.y;
    const d=Math.sqrt(dx*dx+dy*dy)||1, f=SPR*(d-LEN);
    dx/=d; dy/=d;
    a.vx+=f*dx; a.vy+=f*dy; b.vx-=f*dx; b.vy-=f*dy;
  }
  let ke=0;
  for (const n of _gNodes) {
    n.vx-=n.x*CTR; n.vy-=n.y*CTR;
    if (n===_gDragNode) continue;
    n.vx*=DAMP; n.vy*=DAMP; n.x+=n.vx; n.y+=n.vy;
    ke+=n.vx*n.vx+n.vy*n.vy;
  }
  if (ke<_gNodes.length*0.04) _gSimulating=false;
}

function _drawGraph() {
  const canvas=$('graphCanvas'), ctx=canvas.getContext('2d');
  const W=canvas.width, H=canvas.height;
  const dark=document.documentElement.dataset.theme==='dark';
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle=dark?'#0d0c14':'#faf9f7'; ctx.fillRect(0,0,W,H);

  const cx=W/2+_gTransform.x, cy=H/2+_gTransform.y, sc=_gTransform.scale;
  ctx.save(); ctx.translate(cx,cy); ctx.scale(sc,sc);

  // Edges
  for (const e of _gEdges) {
    const a=_gNodeMap[e.s], b=_gNodeMap[e.t]; if(!a||!b) continue;
    const hot=_gHovered&&(_gHovered.id===e.s||_gHovered.id===e.t);
    ctx.strokeStyle=hot?(dark?'rgba(167,139,250,.65)':'rgba(124,58,237,.45)'):(dark?'rgba(255,255,255,.07)':'rgba(0,0,0,.09)');
    ctx.lineWidth=(hot?2:1.2)/sc;
    ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
  }

  // Nodes
  for (const nd of _gNodes) {
    const r=_nodeR(nd), cur=nd.id===currentId, hov=nd===_gHovered;
    ctx.shadowColor=dark?'rgba(167,139,250,.35)':'rgba(124,58,237,.25)';
    ctx.shadowBlur=(cur||hov?18:5)/sc;
    const g=ctx.createRadialGradient(nd.x-r*.3,nd.y-r*.3,0,nd.x,nd.y,r);
    if (cur)      { g.addColorStop(0,dark?'#c4b5fd':'#a78bfa'); g.addColorStop(1,dark?'#7c3aed':'#6366f1'); }
    else if (hov) { g.addColorStop(0,dark?'#a78bfa':'#8b5cf6'); g.addColorStop(1,dark?'#6366f1':'#7c3aed'); }
    else          { g.addColorStop(0,dark?'#27244077':'#eae6e0'); g.addColorStop(1,dark?'#1e1b2e':'#dbd7d0'); }
    ctx.fillStyle=g;
    ctx.beginPath(); ctx.arc(nd.x,nd.y,r,0,Math.PI*2); ctx.fill(); ctx.shadowBlur=0;
    ctx.strokeStyle=cur?(dark?'#a78bfa':'#7c3aed'):hov?(dark?'#818cf8':'#6366f1'):(dark?'rgba(255,255,255,.13)':'rgba(0,0,0,.12)');
    ctx.lineWidth=(cur||hov?2:1)/sc;
    ctx.beginPath(); ctx.arc(nd.x,nd.y,r,0,Math.PI*2); ctx.stroke();

    const fs=Math.max(9,Math.min(13,r*.46))/sc;
    ctx.font=`500 ${fs}px Inter,system-ui,sans-serif`;
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillStyle=cur?'#fff':hov?(dark?'#f0eefa':'#0f0e13'):(dark?'#cdc8db':'#2d2d2d');
    const maxW=r*1.65*sc;
    let lbl=nd.title;
    while (lbl.length>3 && ctx.measureText(lbl).width>maxW) lbl=lbl.slice(0,-2)+'…';
    ctx.fillText(lbl,nd.x,nd.y);
  }
  ctx.restore();
}

function _gWorldPos(canvas,sx,sy) {
  return {
    x:(sx-canvas.width/2-_gTransform.x)/_gTransform.scale,
    y:(sy-canvas.height/2-_gTransform.y)/_gTransform.scale,
  };
}
function _gHitNode(canvas,sx,sy) {
  const w=_gWorldPos(canvas,sx,sy);
  for (const n of _gNodes) { const dx=w.x-n.x,dy=w.y-n.y; if(dx*dx+dy*dy<_nodeR(n)**2) return n; }
  return null;
}

function _initGraphEvents(canvas) {
  canvas.addEventListener('mousemove', e => {
    const r=canvas.getBoundingClientRect(), mx=e.clientX-r.left, my=e.clientY-r.top;
    if (_gDragNode) {
      const w=_gWorldPos(canvas,mx,my);
      _gDragNode.x=w.x; _gDragNode.y=w.y; _gDragNode.vx=0; _gDragNode.vy=0;
      _gSimulating=true;
    } else if (_gPan) {
      _gTransform.x+=mx-_gPan.mx; _gTransform.y+=my-_gPan.my;
      _gPan.mx=mx; _gPan.my=my;
    }
    _gHovered=_gHitNode(canvas,mx,my);
    canvas.style.cursor=_gHovered?'pointer':(_gPan?'grabbing':'grab');
    const tip=$('graphTooltip');
    if (_gHovered) { tip.textContent=_gHovered.title; tip.style.cssText=`left:${e.clientX+14}px;top:${e.clientY-8}px`; tip.classList.remove('hidden'); }
    else tip.classList.add('hidden');
  });
  canvas.addEventListener('mousedown', e => {
    const r=canvas.getBoundingClientRect(), mx=e.clientX-r.left, my=e.clientY-r.top;
    const nd=_gHitNode(canvas,mx,my);
    if (nd) { _gDragNode=nd; _gDragStart={x:e.clientX,y:e.clientY}; canvas.style.cursor='grabbing'; }
    else _gPan={mx,my};
  });
  canvas.addEventListener('click', e => {
    const r=canvas.getBoundingClientRect(), mx=e.clientX-r.left, my=e.clientY-r.top;
    const nd=_gHitNode(canvas,mx,my);
    if (nd) { closeGraph(); selectNote(nd.id); }
  });
  canvas.addEventListener('mouseup', () => {
    _gDragNode=null; _gDragStart=null; _gPan=null;
    canvas.style.cursor=_gHovered?'pointer':'grab';
  });
  canvas.addEventListener('mouseleave', () => {
    _gPan=null; _gHovered=null;
    canvas.style.cursor='grab';
    $('graphTooltip').classList.add('hidden');
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const r=canvas.getBoundingClientRect(), mx=e.clientX-r.left, my=e.clientY-r.top;
    const factor=e.deltaY<0?1.12:1/1.12;
    const ns=Math.max(.15,Math.min(5,_gTransform.scale*factor));
    _gTransform.x-=(mx-canvas.width/2-_gTransform.x)*(ns/_gTransform.scale-1);
    _gTransform.y-=(my-canvas.height/2-_gTransform.y)*(ns/_gTransform.scale-1);
    _gTransform.scale=ns;
  },{passive:false});

  // ── Touch support ──────────────────────────────────────────────────────────
  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    if (e.touches.length === 1) {
      const t = e.touches[0];
      const mx = t.clientX - r.left, my = t.clientY - r.top;
      const nd = _gHitNode(canvas, mx, my);
      if (nd) { _gDragNode = nd; _gDragStart = {x: t.clientX, y: t.clientY}; }
      else     { _gPan = {mx, my}; }
    } else if (e.touches.length === 2) {
      _gDragNode = null; _gPan = null;
      _gTouchDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY);
    }
  }, {passive: false});

  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    if (e.touches.length === 1) {
      const t = e.touches[0];
      const mx = t.clientX - r.left, my = t.clientY - r.top;
      if (_gDragNode) {
        const w = _gWorldPos(canvas, mx, my);
        _gDragNode.x = w.x; _gDragNode.y = w.y;
        _gDragNode.vx = 0; _gDragNode.vy = 0;
        _gSimulating = true;
      } else if (_gPan) {
        _gTransform.x += mx - _gPan.mx;
        _gTransform.y += my - _gPan.my;
        _gPan.mx = mx; _gPan.my = my;
      }
    } else if (e.touches.length === 2 && _gTouchDist) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY);
      const factor = dist / _gTouchDist;
      _gTransform.scale = Math.max(.15, Math.min(5, _gTransform.scale * factor));
      _gTouchDist = dist;
    }
  }, {passive: false});

  canvas.addEventListener('touchend', e => {
    if (_gDragStart) {
      const t = e.changedTouches[0];
      const dx = t.clientX - _gDragStart.x, dy = t.clientY - _gDragStart.y;
      if (Math.hypot(dx, dy) < 8) {
        const r = canvas.getBoundingClientRect();
        const nd = _gHitNode(canvas, t.clientX - r.left, t.clientY - r.top);
        if (nd) { closeGraph(); selectNote(nd.id); }
      }
    }
    _gDragNode = null; _gDragStart = null; _gPan = null; _gTouchDist = null;
  }, {passive: false});
}

function openGraph() {
  if (_gOpen) return;
  _gOpen=true; _gSimulating=true;
  _buildGraph();
  _gTransform={x:0,y:0,scale:1}; _gDragNode=null; _gPan=null; _gHovered=null;
  const overlay=$('graphOverlay');
  overlay.classList.remove('hidden');
  $('graphBtn').classList.add('active');
  const canvas=$('graphCanvas');
  canvas.width=canvas.offsetWidth; canvas.height=canvas.offsetHeight;
  const ro=new ResizeObserver(()=>{ canvas.width=canvas.offsetWidth; canvas.height=canvas.offsetHeight; });
  ro.observe(canvas); canvas._ro=ro;
  cancelAnimationFrame(_gRaf);
  const loop=()=>{ if(_gSimulating)_simStep(); _drawGraph(); if(_gOpen)_gRaf=requestAnimationFrame(loop); };
  loop();
}

function closeGraph() {
  _gOpen=false;
  cancelAnimationFrame(_gRaf);
  $('graphOverlay').classList.add('hidden');
  $('graphBtn').classList.remove('active');
  $('graphTooltip').classList.add('hidden');
  if ($('graphCanvas')._ro) { $('graphCanvas')._ro.disconnect(); $('graphCanvas')._ro=null; }
}

// ── Whimsy & micro-interactions ──────────────────────────────────────────────

// -- Floating particle canvas in the welcome hero --
let _particleCleanup = null;

function startParticles() {
  if (_particleCleanup) return;
  const hero = document.querySelector('.welcome-hero');
  if (!hero) return;

  const canvas = document.createElement('canvas');
  Object.assign(canvas.style, {
    position: 'absolute', inset: '0', width: '100%', height: '100%',
    pointerEvents: 'none', zIndex: '0',
  });
  hero.prepend(canvas);
  const ctx = canvas.getContext('2d');
  let w = 0, h = 0;

  const resize = () => { w = canvas.width = hero.offsetWidth; h = canvas.height = hero.offsetHeight; };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(hero);

  const COUNT = 30;
  const mkP = () => ({
    x: Math.random() * w, y: h + 10,
    r: Math.random() * 1.8 + 0.5,
    vy: Math.random() * 0.35 + 0.12,
    vx: (Math.random() - 0.5) * 0.22,
    a:  Math.random() * 0.40 + 0.15,
    life: 0, max: Math.random() * 260 + 100,
  });
  const pts = Array.from({ length: COUNT }, () => {
    const p = mkP(); p.y = Math.random() * h; p.life = Math.random() * p.max; return p;
  });

  let raf;
  const tick = () => {
    ctx.clearRect(0, 0, w, h);
    const rgb = document.documentElement.dataset.theme === 'dark' ? '167,139,250' : '124,58,237';
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      p.y -= p.vy; p.x += p.vx; p.life++;
      const t = p.life / p.max;
      const a = t < 0.2 ? t / 0.2 : t > 0.75 ? (1 - t) / 0.25 : 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${rgb},${p.a * a})`;
      ctx.fill();
      if (p.life >= p.max || p.y < -8) pts[i] = mkP();
    }
    raf = requestAnimationFrame(tick);
  };
  tick();

  _particleCleanup = () => { cancelAnimationFrame(raf); ro.disconnect(); canvas.remove(); _particleCleanup = null; };
}

function stopParticles() { if (_particleCleanup) _particleCleanup(); }

// -- Bento card 3D tilt following cursor --
function initBentoTilt() {
  document.querySelectorAll('.bento-card').forEach(card => {
    card.addEventListener('mousemove', e => {
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width  - 0.5;
      const y = (e.clientY - r.top)  / r.height - 0.5;
      card.style.transform = `perspective(700px) rotateX(${-y * 10}deg) rotateY(${x * 10}deg) translateY(-5px) scale(1.01)`;
    });
    card.addEventListener('mouseleave', () => { card.style.transform = ''; });
  });
}

// -- Ripple on gradient CTA buttons --
function initRipple() {
  document.querySelectorAll('.btn-new, .btn-primary-lg').forEach(btn => {
    btn.addEventListener('click', e => {
      const r = btn.getBoundingClientRect();
      const span = document.createElement('span');
      span.className = 'ripple';
      span.style.left = `${e.clientX - r.left - 3}px`;
      span.style.top  = `${e.clientY - r.top  - 3}px`;
      btn.appendChild(span);
      span.addEventListener('animationend', () => span.remove(), { once: true });
    });
  });
}

// -- Set --i stagger index on note items after render --
function staggerNoteItems() {
  notesList.querySelectorAll('.note-item').forEach((el, i) => el.style.setProperty('--i', i));
}

// -- Wire all whimsy on boot --
function initWhimsy() {
  initBentoTilt();
  initRipple();
}

document.addEventListener('DOMContentLoaded', init);
