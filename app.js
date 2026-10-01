/* SOMA Events — suivi des invités
 * Front statique (GitHub Pages). Les données vivent dans un dépôt privé, lues/écrites via l'API GitHub
 * avec le token de l'utilisateur. Aucune donnée n'est stockée dans ce dépôt public.
 */
'use strict';

const STATUTS = ['À inviter', 'Invité', 'Confirmé', 'Peut-être', 'Absent'];
const STATUT_CLASS = { 'À inviter': 's-inviter', 'Invité': 's-invite', 'Confirmé': 's-confirme', 'Peut-être': 's-peutetre', 'Absent': 's-absent' };
const LS = { token: 'se.token', repo: 'se.repo', event: 'se.event' };

const state = {
  token: '', repo: '',
  events: [],          // [{id}]
  eventId: '',
  event: null, eventSha: null,
  guests: [], guestsSha: null,
  sort: { key: 'statut', desc: false },
  filter: { q: '', statut: '', societe: '' },
  editingId: null,
  shareMode: 'whatsapp',
  pendingImport: null,
};

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’'`-]/g, ' ').replace(/\s+/g, ' ').trim();
const store = {
  get(k) { try { return localStorage.getItem(k) ?? sessionStorage.getItem(k); } catch { return null; } },
  set(k, v, persist = true) { try { (persist ? localStorage : sessionStorage).setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch {} },
};

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}
function setSync(kind, title) {
  const s = $('#sync'); s.className = 'sync ' + (kind || ''); s.title = title || '';
  s.textContent = kind === 'saving' ? '● Enregistrement…' : kind === 'error' ? '● Erreur de synchro' : '● Synchronisé';
}

/* ---------------- GitHub API ---------------- */
const b64encode = str => { const bytes = new TextEncoder().encode(str); let bin = ''; bytes.forEach(b => bin += String.fromCharCode(b)); return btoa(bin); };
const b64decode = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, '')), c => c.charCodeAt(0)));

async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${state.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) },
    cache: 'no-store',
  });
  if (!res.ok) { const err = new Error(`GitHub ${res.status}`); err.status = res.status; try { err.body = await res.json(); } catch {} throw err; }
  return res.status === 204 ? null : res.json();
}
const bytesToB64 = bytes => { let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin); };
async function readRaw(path) {
  const res = await fetch(`https://api.github.com/repos/${state.repo}/contents/${encodeURI(path)}`, {
    headers: { Authorization: `Bearer ${state.token}`, Accept: 'application/vnd.github.raw', 'X-GitHub-Api-Version': '2022-11-28' }, cache: 'no-store',
  });
  if (!res.ok) { const err = new Error(`GitHub ${res.status} (${path})`); err.status = res.status; throw err; }
  return new Uint8Array(await res.arrayBuffer());
}
async function writeRaw(path, bytes, message) {
  let sha;
  try { sha = (await gh(`/repos/${state.repo}/contents/${encodeURI(path)}`)).sha; } catch (e) { if (e.status !== 404) throw e; }
  await gh(`/repos/${state.repo}/contents/${encodeURI(path)}`, { method: 'PUT', body: JSON.stringify({ message, content: bytesToB64(bytes), ...(sha ? { sha } : {}) }) });
}
async function readJson(path) {
  const r = await gh(`/repos/${state.repo}/contents/${encodeURI(path)}`);
  return { data: JSON.parse(b64decode(r.content)), sha: r.sha };
}
async function writeJson(path, data, sha, message) {
  const body = { message, content: b64encode(JSON.stringify(data, null, 2) + '\n') };
  if (sha) body.sha = sha;
  const r = await gh(`/repos/${state.repo}/contents/${encodeURI(path)}`, { method: 'PUT', body: JSON.stringify(body) });
  return r.content.sha;
}

/* ---------------- Connexion ---------------- */
async function login(token, repo, remember) {
  state.token = token; state.repo = repo;
  const info = await gh(`/repos/${repo}`);
  if (!info.private) throw new Error("Ce dépôt est PUBLIC : refusé pour protéger les données personnelles.");
  if (info.permissions && !info.permissions.push) toast('Accès en lecture seule : les modifications ne seront pas enregistrées.', 5000);
  store.set(LS.token, token, remember); store.set(LS.repo, repo, remember);
}
function logout() {
  store.del(LS.token); store.del(LS.repo);
  location.reload();
}

/* ---------------- Événements ---------------- */
async function loadEvents() {
  let items = [];
  try { items = await gh(`/repos/${state.repo}/contents/events`); } catch (e) { if (e.status !== 404) throw e; }
  state.events = items.filter(i => i.type === 'dir').map(i => ({ id: i.name })).sort((a, b) => b.id.localeCompare(a.id));
}
async function openEvent(id) {
  state.eventId = id; store.set(LS.event, id);
  const [ev, gs] = await Promise.all([readJson(`events/${id}/event.json`), readJson(`events/${id}/guests.json`)]);
  state.event = ev.data; state.eventSha = ev.sha;
  state.guests = gs.data.guests || []; state.guestsSha = gs.sha;
  state.filter = { q: '', statut: '', societe: '' }; $('#search').value = '';
  renderAll();
}
function renderEventSelect() {
  const sel = $('#event-select');
  sel.innerHTML = state.events.map(e => `<option value="${esc(e.id)}">${esc(e.id)}</option>`).join('');
  sel.value = state.eventId;
}
function fmtDate(d) {
  if (!d) return '';
  return new Date(d + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

/* ---------------- Sauvegarde (debounce) ---------------- */
let saveTimer = null, saving = Promise.resolve();
function scheduleSave(msg = 'Mise à jour des invités') {
  setSync('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saving = saving.then(() => saveGuests(msg)); }, 1200);
}
async function saveGuests(msg) {
  const path = `events/${state.eventId}/guests.json`;
  try {
    state.guestsSha = await writeJson(path, { version: 1, guests: state.guests }, state.guestsSha, `${state.eventId} : ${msg}`);
    setSync('ok', 'Enregistré ' + new Date().toLocaleTimeString('fr-FR'));
  } catch (e) {
    if (e.status === 409 || e.status === 422) {
      // Conflit : le fichier a été modifié ailleurs. On réapplique nos données sur la dernière version.
      try {
        const remote = await readJson(path);
        state.guestsSha = await writeJson(path, { version: 1, guests: state.guests }, remote.sha, `${state.eventId} : ${msg}`);
        setSync('ok'); return;
      } catch {}
    }
    setSync('error', e.message); toast('Échec de l’enregistrement : ' + (e.body?.message || e.message), 6000);
  }
}
window.addEventListener('beforeunload', e => { if ($('#sync').classList.contains('saving')) { e.preventDefault(); e.returnValue = ''; } });

/* ---------------- Rendu ---------------- */
function renderAll() {
  renderEventSelect(); renderHead(); renderFilters(); renderStats(); renderTable();
}
function renderHead() {
  const ev = state.event;
  $('#ev-title').textContent = ev.titre || state.eventId;
  $('#ev-meta').textContent = [fmtDate(ev.date), ev.heure_debut && `à partir de ${ev.heure_debut.replace(':', 'h')}`, ev.lieu].filter(Boolean).join(' · ');
  document.title = `${ev.titre || 'Événement'} · Invités`;
}
function societes() { return [...new Set(state.guests.map(g => g.societe).filter(Boolean))].sort(); }
function renderFilters() {
  const fs = $('#filter-statut'), fc = $('#filter-societe');
  fs.innerHTML = '<option value="">Tous les statuts</option>' + STATUTS.map(s => `<option>${esc(s)}</option>`).join('');
  fs.value = state.filter.statut;
  fc.innerHTML = '<option value="">Toutes les sociétés</option>' + societes().map(s => `<option>${esc(s)}</option>`).join('');
  fc.value = state.filter.societe;
  $('#societes').innerHTML = societes().map(s => `<option value="${esc(s)}">`).join('');
}
function renderStats() {
  const c = Object.fromEntries(STATUTS.map(s => [s, 0]));
  state.guests.forEach(g => { c[g.statut] = (c[g.statut] || 0) + 1; });
  const cards = [['', 'Total', state.guests.length], ...STATUTS.map(s => [s, s, c[s]])];
  $('#stats').innerHTML = cards.map(([k, label, n]) =>
    `<button class="stat ${state.filter.statut === k ? 'active' : ''}" data-statut="${esc(k)}"><b>${n}</b><span>${esc(label)}</span></button>`).join('');
}
function filtered() {
  const q = norm(state.filter.q);
  const order = Object.fromEntries(STATUTS.map((s, i) => [s, i]));
  const { key, desc } = state.sort;
  return state.guests
    .filter(g => !state.filter.statut || g.statut === state.filter.statut)
    .filter(g => !state.filter.societe || g.societe === state.filter.societe)
    .filter(g => !q || norm(`${g.prenom} ${g.nom} ${g.email} ${g.societe} ${g.commentaire} ${g.departement}`).includes(q))
    .sort((a, b) => {
      let r;
      if (key === 'statut') r = (order[a.statut] ?? 99) - (order[b.statut] ?? 99);
      else if (key === 'invitation_envoyee') r = (a.invitation_envoyee ? 1 : 0) - (b.invitation_envoyee ? 1 : 0);
      else r = norm(a[key]).localeCompare(norm(b[key]));
      if (r === 0) r = norm(a.nom).localeCompare(norm(b.nom));
      return desc ? -r : r;
    });
}
function renderTable() {
  const rows = filtered();
  $('#tbody').innerHTML = rows.map(g => `
    <tr data-id="${esc(g.id)}">
      <td><span class="name">${esc(g.prenom)} ${esc(g.nom)}</span>${g.departement ? `<span class="dept">${esc(g.departement)}</span>` : ''}</td>
      <td>${esc(g.societe)}</td>
      <td class="col-email" title="${esc(g.email)}">${g.email ? esc(g.email) : '<span class="missing">manquant</span>'}</td>
      <td><select class="statut ${STATUT_CLASS[g.statut] || ''}" data-f="statut">${STATUTS.map(s => `<option ${s === g.statut ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></td>
      <td><input type="checkbox" data-f="invitation_envoyee" ${g.invitation_envoyee ? 'checked' : ''} aria-label="Invitation envoyée"></td>
      <td><input class="comment" data-f="commentaire" value="${esc(g.commentaire)}" placeholder="—"></td>
      <td class="col-actions">
        <button class="icon-btn" data-a="mail" title="Ouvrir un mail pré-rempli">✉️</button>
        <button class="icon-btn" data-a="eml" title="Télécharger le brouillon Outlook (.eml)">📥</button>
        <button class="icon-btn" data-a="edit" title="Modifier">✏️</button>
        <button class="icon-btn" data-a="del" title="Supprimer">🗑️</button>
      </td>
    </tr>`).join('');
  $('#empty').classList.toggle('hidden', rows.length > 0);
  $$('th[data-sort]').forEach(th => { th.classList.toggle('sorted', th.dataset.sort === state.sort.key); th.classList.toggle('desc', th.dataset.sort === state.sort.key && state.sort.desc); });
}
const guestById = id => state.guests.find(g => g.id === id);
const newId = () => 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* ---------------- Interactions tableau ---------------- */
function bindTable() {
  $('#tbody').addEventListener('change', e => {
    const tr = e.target.closest('tr'); const f = e.target.dataset.f; if (!tr || !f) return;
    const g = guestById(tr.dataset.id);
    g[f] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (f === 'statut') { e.target.className = 'statut ' + (STATUT_CLASS[g.statut] || ''); if (g.statut !== 'À inviter' && g.statut !== 'Absent' && !g.invitation_envoyee) { g.invitation_envoyee = true; tr.querySelector('[data-f=invitation_envoyee]').checked = true; } renderStats(); }
    scheduleSave(`${g.prenom} ${g.nom} — ${f}`);
  });
  $('#tbody').addEventListener('click', e => {
    const btn = e.target.closest('[data-a]'); if (!btn) return;
    const g = guestById(btn.closest('tr').dataset.id);
    if (btn.dataset.a === 'mail') openMailto(g);
    if (btn.dataset.a === 'eml') emlFor(g).then(eml => downloadBlob(new Blob([eml], { type: 'message/rfc822' }), emlName(g)));
    if (btn.dataset.a === 'edit') openGuestDialog(g);
    if (btn.dataset.a === 'del' && confirm(`Retirer ${g.prenom} ${g.nom} de la liste ?`)) {
      state.guests = state.guests.filter(x => x !== g); renderAll(); scheduleSave(`Suppression ${g.prenom} ${g.nom}`);
    }
  });
  $$('th[data-sort]').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.sort; state.sort = { key: k, desc: state.sort.key === k ? !state.sort.desc : false }; renderTable();
  }));
  $('#stats').addEventListener('click', e => {
    const b = e.target.closest('.stat'); if (!b) return;
    state.filter.statut = state.filter.statut === b.dataset.statut ? '' : b.dataset.statut;
    $('#filter-statut').value = state.filter.statut; renderStats(); renderTable();
  });
  $('#search').addEventListener('input', e => { state.filter.q = e.target.value; renderTable(); });
  $('#filter-statut').addEventListener('change', e => { state.filter.statut = e.target.value; renderStats(); renderTable(); });
  $('#filter-societe').addEventListener('change', e => { state.filter.societe = e.target.value; renderTable(); });
}

/* ---------------- Invitation : texte, mailto, .eml, .ics ---------------- */
function personalize(tpl, g) {
  const ev = state.event;
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => ({ prenom: g.prenom, nom: g.nom, societe: g.societe, signature: ev.signature || '' }[k] ?? m));
}
function openMailto(g) {
  if (!g.email) return toast('Pas d’email pour cet invité.');
  const url = `mailto:${encodeURIComponent(g.email)}?subject=${encodeURIComponent(personalize(state.event.objet_mail || state.event.titre, g))}&body=${encodeURIComponent(personalize(state.event.message, g))}`;
  location.href = url;
}
function parisToUtc(date, time) {
  // Convertit une date/heure locale Europe/Paris en Date UTC (gère l'heure d'été).
  const [y, m, d] = date.split('-').map(Number); const [hh, mm] = (time || '18:00').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess)).map(p => [p.type, p.value]));
  const asParis = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return new Date(guess - (asParis - guess));
}
const icsDate = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = s => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, m => '\\' + m);
function buildIcs() {
  const ev = state.event;
  const start = parisToUtc(ev.date, ev.heure_debut), end = parisToUtc(ev.date, ev.heure_fin || '23:00');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SOMA//Events//FR', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${state.eventId}@soma-events`, `DTSTAMP:${icsDate(new Date())}`, `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsText(ev.titre)}`, `LOCATION:${icsText(ev.lieu)}`, `DESCRIPTION:${icsText(personalize(ev.message, { prenom: '', nom: '', societe: '' }).replace(/^Bonjour ,\s*(Je t'invite[^\n]*\n\s*)?/, ''))}`,
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}
const mimeWord = s => `=?UTF-8?B?${b64encode(s)}?=`;
const wrap76 = s => s.replace(/.{1,76}/g, '$&\r\n');
const attCache = new Map();
async function loadAttachments() {
  const list = state.event.pieces_jointes || [];
  return Promise.all(list.map(async pj => {
    const key = `${state.eventId}/${pj.fichier}`;
    if (!attCache.has(key)) attCache.set(key, readRaw(`events/${key}`).then(bytesToB64).catch(e => { attCache.delete(key); throw e; }));
    return { nom: pj.nom || pj.fichier, type: pj.type || 'application/pdf', b64: await attCache.get(key) };
  }));
}
const attHeaders = (nom, type) => [`Content-Type: ${type}; name="${mimeWord(nom)}"`,
  `Content-Disposition: attachment; filename="${mimeWord(nom)}"; filename*=UTF-8''${encodeURIComponent(nom)}`, 'Content-Transfer-Encoding: base64', ''];
async function emlFor(g) {
  try { return buildEml(g, await loadAttachments()); }
  catch (e) { toast('Pièce jointe introuvable : ' + e.message, 6000); throw e; }
}
function buildEml(g, atts = []) {
  const ev = state.event;
  const text = personalize(ev.message, g);
  const html = `<html><body style="font-family:Aptos,Calibri,Arial,sans-serif;font-size:11pt">${esc(text).replace(/\n/g, '<br>')}</body></html>`;
  const b1 = 'mix_' + Math.random().toString(36).slice(2), b2 = 'alt_' + Math.random().toString(36).slice(2);
  return [
    'X-Unsent: 1',
    ...(ev.expediteur ? [`From: ${mimeWord(ev.organisateur || '')} <${ev.expediteur}>`] : []),
    `To: ${mimeWord(`${g.prenom} ${g.nom}`)} <${g.email || ''}>`,
    `Subject: ${mimeWord(personalize(ev.objet_mail || ev.titre, g))}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${b1}"`, '',
    `--${b1}`, `Content-Type: multipart/alternative; boundary="${b2}"`, '',
    `--${b2}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap76(b64encode(text)),
    `--${b2}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap76(b64encode(html)),
    `--${b2}--`, '',
    ...atts.flatMap(a => [`--${b1}`, ...attHeaders(a.nom, a.type), wrap76(a.b64)]),
    `--${b1}`, 'Content-Type: text/calendar; charset=UTF-8; method=PUBLISH; name="invitation.ics"',
    'Content-Disposition: attachment; filename="invitation.ics"', 'Content-Transfer-Encoding: base64', '', wrap76(b64encode(buildIcs())),
    `--${b1}--`, '',
  ].join('\r\n');
}
const emlName = g => `${state.eventId}_${norm(g.prenom + ' ' + g.nom).replace(/[^a-z0-9]+/g, '-')}.eml`;
function downloadBlob(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function downloadAllEml() {
  const targets = state.guests.filter(g => g.email && g.statut !== 'Absent');
  if (!targets.length) return toast('Aucun invité avec email.');
  toast('Préparation des brouillons…');
  const atts = await loadAttachments().catch(e => { toast('Pièce jointe introuvable : ' + e.message, 6000); throw e; });
  const zip = new JSZip();
  targets.forEach(g => zip.file(emlName(g), buildEml(g, atts)));
  downloadBlob(await zip.generateAsync({ type: 'blob' }), `${state.eventId}_brouillons.zip`);
  toast(`${targets.length} brouillons générés (hors absents).`);
}

/* ---------------- Copier pour WhatsApp / Teams ---------------- */
function buildShareText(mode) {
  const wa = mode === 'whatsapp';
  const B = s => wa ? `*${s}*` : `**${s}**`;
  const withComments = $('#sh-comments').checked, withPending = $('#sh-pending').checked, withCo = $('#sh-company').checked;
  const ev = state.event;
  const by = s => state.guests.filter(g => s.includes(g.statut)).sort((a, b) => norm(a.nom).localeCompare(norm(b.nom)));
  const line = g => `• ${g.prenom} ${g.nom}${withCo && g.societe ? ` (${g.societe})` : ''}${withComments && g.commentaire ? ` — ${g.commentaire}` : ''}`;
  const groups = [
    ['✅', 'Présents', by(['Confirmé'])],
    ['🤔', 'Peut-être', by(['Peut-être'])],
    ['❌', 'Absents', by(['Absent'])],
  ];
  if (withPending) groups.push(['⏳', 'En attente de réponse', by(['Invité'])], ['📝', 'Pas encore invités', by(['À inviter'])]);
  const d = ev.date ? new Date(ev.date + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
  const head = `${B(`💿 ${ev.titre}`)}\n📅 ${d}${ev.heure_debut ? ' · ' + ev.heure_debut.replace(':', 'h') : ''}${ev.lieu ? ' · 📍 ' + ev.lieu : ''}`;
  const summary = groups.map(([e, l, a]) => `${e} ${a.length}`).join('  ');
  const body = groups.filter(([, , a]) => a.length).map(([e, l, a]) => `${e} ${B(`${l} (${a.length})`)}\n${a.map(line).join('\n')}`).join('\n\n');
  return `${head}\n${summary}\n\n${body}`;
}
function openShare(mode) {
  state.shareMode = mode;
  $('#share-title').textContent = `Copier la liste pour ${mode === 'whatsapp' ? 'WhatsApp' : 'Teams'}`;
  $('#share-text').value = buildShareText(mode);
  $('#dlg-share').showModal();
}

/* ---------------- Excel ---------------- */
const EXPORT_COLS = [['prenom', 'Prénom'], ['nom', 'Nom'], ['societe', 'Société'], ['email', 'Email'], ['departement', 'Département'], ['statut', 'Statut'], ['invitation_envoyee', 'Invitation envoyée'], ['commentaire', 'Commentaire']];
function exportExcel() {
  const rows = filtered().map(g => Object.fromEntries(EXPORT_COLS.map(([k, l]) => [l, k === 'invitation_envoyee' ? (g[k] ? 'Oui' : 'Non') : (g[k] ?? '')])));
  const ws = XLSX.utils.json_to_sheet(rows, { header: EXPORT_COLS.map(c => c[1]) });
  ws['!cols'] = [12, 16, 14, 34, 30, 12, 10, 40].map(w => ({ wch: w }));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Invités');
  XLSX.writeFile(wb, `${state.eventId}_invites.xlsx`);
}
function downloadTemplate() {
  const ws = XLSX.utils.aoa_to_sheet([EXPORT_COLS.map(c => c[1]), ['Marie', 'DUPONT', 'Client SA', 'marie.dupont@client.com', '', 'À inviter', 'Non', '']]);
  ws['!cols'] = [12, 16, 14, 34, 30, 12, 10, 40].map(w => ({ wch: w }));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Invités');
  XLSX.writeFile(wb, 'modele_import_invites.xlsx');
}
async function readSheet(file) {
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false });
}
const ALIASES = {
  prenom: ['prenom', 'first name', 'firstname', 'given name'],
  nom: ['nom', 'name', 'last name', 'lastname', 'surname', 'nom de famille'],
  email: ['email', 'e mail', 'mail', 'adresse mail', 'courriel'],
  societe: ['societe', 'client', 'entreprise', 'company', 'organisation'],
  departement: ['departement', 'departement n2', 'direction', 'service', 'department'],
  statut: ['statut', 'status', 'etat'],
  commentaire: ['commentaire', 'commentaires', 'comment', 'remarque', 'notes'],
  invitation_envoyee: ['invitation envoyee', 'envoyee', 'invite le'],
};
function mapRow(row) {
  const out = {};
  for (const [col, val] of Object.entries(row)) {
    const n = norm(col).replace(/_/g, ' ');
    for (const [k, al] of Object.entries(ALIASES)) if (!(k in out) && al.includes(n)) out[k] = String(val).trim();
  }
  return out;
}
function normStatut(s) {
  const n = norm(s);
  if (!n) return 'À inviter';
  if (/absent|excus|decline|non/.test(n)) return 'Absent';
  if (/peut|maybe|incertain/.test(n)) return 'Peut-être';
  if (/confirm|present|oui|sera/.test(n)) return 'Confirmé';
  if (/a inviter|todo/.test(n)) return 'À inviter';
  if (/invit/.test(n)) return 'Invité';
  return 'À inviter';
}
async function startImport(file) {
  const rows = (await readSheet(file)).map(mapRow).filter(r => r.nom || r.email);
  if (!rows.length) return toast('Aucune ligne exploitable (colonnes attendues : Prénom, Nom, Email…).', 5000);
  state.pendingImport = rows;
  $('#import-summary').textContent = `${rows.length} ligne(s) lue(s) depuis « ${file.name} ».`;
  $('#import-preview').innerHTML = `<table><tr><th>Prénom</th><th>Nom</th><th>Société</th><th>Email</th><th>Statut</th></tr>${rows.slice(0, 50).map(r => `<tr><td>${esc(r.prenom)}</td><td>${esc(r.nom)}</td><td>${esc(r.societe)}</td><td>${esc(r.email)}</td><td>${esc(normStatut(r.statut))}</td></tr>`).join('')}</table>`;
  $('#dlg-import').showModal();
}
function applyImport(mode) {
  const rows = state.pendingImport; if (!rows) return;
  if (mode === 'replace') state.guests = [];
  let added = 0, updated = 0;
  for (const r of rows) {
    const key = g => (r.email && g.email && norm(g.email) === norm(r.email)) || (norm(g.prenom) === norm(r.prenom) && norm(g.nom) === norm(r.nom));
    const ex = state.guests.find(key);
    const data = {
      prenom: r.prenom || '', nom: r.nom || '', email: r.email || '', societe: r.societe || '', departement: r.departement || '',
      commentaire: r.commentaire || '', statut: normStatut(r.statut), invitation_envoyee: /^(oui|yes|true|1|x)$/i.test(r.invitation_envoyee || ''),
    };
    if (ex) { for (const [k, v] of Object.entries(data)) if (v !== '' && v !== false && !(k === 'statut' && !r.statut)) ex[k] = v; updated++; }
    else { state.guests.push({ id: newId(), ...data }); added++; }
  }
  state.pendingImport = null;
  const filled = fillEmailsFromContacts(true);
  renderAll(); scheduleSave(`Import Excel (${added} ajout(s), ${updated} mise(s) à jour)`);
  toast(`${added} ajouté(s), ${updated} mis à jour${filled ? `, ${filled} email(s) complété(s) depuis la base` : ''}.`, 4000);
}

/* ---------------- Base de contacts (locale, IndexedDB) ---------------- */
const contactsDb = {
  _db: null,
  open() {
    if (this._db) return this._db;
    this._db = new Promise((res, rej) => {
      const r = indexedDB.open('soma-events', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('bases', { keyPath: 'societe' });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return this._db;
  },
  async tx(mode, fn) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('bases', mode); const r = fn(t.objectStore('bases')); t.oncomplete = () => res(r?.result); t.onerror = () => rej(t.error); }); },
  all() { return this.tx('readonly', s => s.getAll()); },
  put(b) { return this.tx('readwrite', s => s.put(b)); },
  del(k) { return this.tx('readwrite', s => s.delete(k)); },
};
let contacts = []; // [{prenom, nom, email, departement, societe, _k}]
async function loadContacts() {
  try {
    const bases = await contactsDb.all();
    contacts = bases.flatMap(b => b.rows.map(r => ({ ...r, societe: b.societe, _k: norm(`${r.prenom} ${r.nom} ${r.email}`) })));
    return bases;
  } catch { contacts = []; return []; }
}
async function renderContactsDialog() {
  const bases = await loadContacts();
  $('#contacts-list').innerHTML = bases.length
    ? bases.map(b => `<div class="base"><span><strong>${esc(b.societe)}</strong> — ${b.rows.length.toLocaleString('fr-FR')} contacts <small class="muted">(importée le ${new Date(b.date).toLocaleDateString('fr-FR')})</small></span><button type="button" class="btn small" data-del-base="${esc(b.societe)}">Supprimer</button></div>`).join('')
    : '<p class="muted">Aucune base importée sur ce navigateur.</p>';
}
async function importContacts(file, societe) {
  $('#c-status').textContent = 'Lecture…';
  const raw = await readSheet(file);
  const rows = raw.map(r => {
    const o = {};
    for (const [col, val] of Object.entries(r)) {
      const n = norm(col).replace(/_/g, ' ');
      if (n === 'prenom' || n === 'first name') o.prenom = String(val).trim();
      else if (n === 'nom' || n === 'last name') o.nom = String(val).trim();
      else if (/^(e )?mail|^email/.test(n)) o.email = String(val).trim();
      else if (n === 'departement n2' || (!o.departement && /departement|direction|service/.test(n))) o.departement = String(val).trim();
    }
    return o;
  }).filter(o => o.nom && o.email);
  if (!rows.length) { $('#c-status').textContent = 'Aucun contact reconnu (colonnes NOM, PRENOM, EMAIL attendues).'; return; }
  const title = s => s.toLowerCase().replace(/(^|[\s'’-])\p{L}/gu, m => m.toUpperCase());
  rows.forEach(r => { r.prenom = title(r.prenom || ''); r.departement = r.departement ? title(r.departement) : ''; });
  await contactsDb.put({ societe, date: Date.now(), rows });
  $('#c-status').textContent = `${rows.length.toLocaleString('fr-FR')} contacts importés pour ${societe}.`;
  await renderContactsDialog();
}
function fillEmailsFromContacts(silent) {
  let n = 0;
  for (const g of state.guests) {
    if (g.email) continue;
    const m = contacts.filter(c => norm(c.prenom) === norm(g.prenom) && norm(c.nom) === norm(g.nom) && (!g.societe || norm(c.societe) === norm(g.societe)));
    if (m.length === 1) { g.email = m[0].email; g.departement ||= m[0].departement; g.societe ||= m[0].societe; n++; }
  }
  if (!silent) { renderAll(); if (n) scheduleSave(`${n} email(s) complété(s)`); toast(n ? `${n} email(s) complété(s).` : 'Aucun email à compléter (ou correspondance ambiguë).'); }
  return n;
}

/* ---------------- Dialogue invité ---------------- */
function openGuestDialog(g) {
  state.editingId = g?.id || null;
  $('#guest-title').textContent = g ? `Modifier ${g.prenom} ${g.nom}` : 'Ajouter un invité';
  $('#g-statut').innerHTML = STATUTS.map(s => `<option>${esc(s)}</option>`).join('');
  for (const k of ['prenom', 'nom', 'societe', 'email', 'departement', 'commentaire']) $('#g-' + k).value = g?.[k] || '';
  $('#g-statut').value = g?.statut || 'À inviter';
  $('#g-search').value = ''; $('#g-suggest').classList.add('hidden');
  $('#g-base-info').textContent = contacts.length ? `${contacts.length.toLocaleString('fr-FR')} contacts disponibles` : 'Aucune base importée (menu Excel & mails → Base de contacts).';
  $('#dlg-guest').showModal();
}
function bindGuestDialog() {
  let matches = [];
  $('#g-search').addEventListener('input', e => {
    const q = norm(e.target.value); const box = $('#g-suggest');
    if (q.length < 2) { box.classList.add('hidden'); return; }
    const terms = q.split(' ');
    matches = contacts.filter(c => terms.every(t => c._k.includes(t))).slice(0, 30);
    box.innerHTML = matches.length ? matches.map((c, i) => `<div data-i="${i}"><strong>${esc(c.prenom)} ${esc(c.nom)}</strong> <small>${esc(c.email)} · ${esc(c.societe)}${c.departement ? ' · ' + esc(c.departement) : ''}</small></div>`).join('') : '<div><small>Aucun résultat</small></div>';
    box.classList.remove('hidden');
  });
  $('#g-suggest').addEventListener('click', e => {
    const d = e.target.closest('[data-i]'); if (!d) return;
    const c = matches[+d.dataset.i];
    $('#g-prenom').value = c.prenom; $('#g-nom').value = c.nom; $('#g-email').value = c.email; $('#g-societe').value = c.societe; $('#g-departement').value = c.departement || '';
    $('#g-suggest').classList.add('hidden');
  });
  $('#dlg-guest').addEventListener('close', () => {
    if ($('#dlg-guest').returnValue !== 'ok') return;
    const data = Object.fromEntries(['prenom', 'nom', 'societe', 'email', 'departement', 'commentaire', 'statut'].map(k => [k, $('#g-' + k).value.trim()]));
    if (state.editingId) Object.assign(guestById(state.editingId), data);
    else {
      if (state.guests.some(g => (data.email && norm(g.email) === norm(data.email)) || (norm(g.prenom) === norm(data.prenom) && norm(g.nom) === norm(data.nom))) && !confirm('Cet invité semble déjà dans la liste. Ajouter quand même ?')) return;
      state.guests.push({ id: newId(), ...data, invitation_envoyee: false });
    }
    renderAll(); scheduleSave(`${state.editingId ? 'Modification' : 'Ajout'} ${data.prenom} ${data.nom}`);
  });
}

/* ---------------- Dialogue événement ---------------- */
let creatingEvent = false, dlgAtts = [];
function renderDlgAtts() {
  $('#e-pj-list').innerHTML = dlgAtts.map((a, i) => `<span class="chip">📎 ${esc(a.nom || a.fichier)} <button type="button" class="icon-btn" data-rm-pj="${i}" title="Retirer">✕</button></span>`).join('') || '<span class="muted">Aucune</span>';
}
const EV_FIELDS = [['titre', 'e-titre'], ['date', 'e-date'], ['lieu', 'e-lieu'], ['heure_debut', 'e-debut'], ['heure_fin', 'e-fin'], ['organisateur', 'e-orga'], ['signature', 'e-signature'], ['expediteur', 'e-expediteur'], ['objet_mail', 'e-objet'], ['message', 'e-message']];
function openEventDialog(create) {
  creatingEvent = create;
  $('#event-dlg-title').textContent = create ? 'Nouvel événement' : 'Événement & message d’invitation';
  const src = state.event || {};
  for (const [k, id] of EV_FIELDS) $('#' + id).value = create && ['titre', 'date', 'objet_mail'].includes(k) ? '' : (src[k] || '');
  $('#e-copy-wrap').classList.toggle('hidden', !create); $('#e-copy').checked = false;
  dlgAtts = create ? [] : [...(src.pieces_jointes || [])]; $('#e-pj').value = ''; renderDlgAtts();
  $('#dlg-event').showModal();
}
function slug(s) { return norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40); }
async function saveEventDialog() {
  const data = Object.fromEntries(EV_FIELDS.map(([k, id]) => [k, $('#' + id).value]));
  const newFiles = [...$('#e-pj').files];
  try {
    setSync('saving');
    const evId = creatingEvent ? `${data.date}-${slug(data.titre)}` : state.eventId;
    for (const f of newFiles) {
      const fichier = slug(f.name.replace(/\.[^.]+$/, '')) + (f.name.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
      await writeRaw(`events/${evId}/${fichier}`, new Uint8Array(await f.arrayBuffer()), `${evId} : pièce jointe ${f.name}`);
      attCache.delete(`${evId}/${fichier}`);
      dlgAtts = dlgAtts.filter(a => a.fichier !== fichier).concat({ fichier, nom: f.name, type: f.type || 'application/octet-stream' });
    }
    data.pieces_jointes = dlgAtts;
    if (creatingEvent) {
      const id = `${data.date}-${slug(data.titre)}`;
      if (state.events.some(e => e.id === id)) return toast('Un événement avec cette date et ce titre existe déjà.', 4000);
      const guests = $('#e-copy').checked ? state.guests.map(g => ({ ...g, statut: 'À inviter', invitation_envoyee: false, commentaire: '' })) : [];
      await writeJson(`events/${id}/event.json`, { id, ...data }, null, `Création de l'événement ${id}`);
      await writeJson(`events/${id}/guests.json`, { version: 1, guests }, null, `${id} : liste d'invités initiale`);
      await loadEvents(); await openEvent(id);
    } else {
      Object.assign(state.event, data);
      state.eventSha = await writeJson(`events/${state.eventId}/event.json`, state.event, state.eventSha, `${state.eventId} : mise à jour de l'événement`);
      renderHead();
    }
    setSync('ok');
  } catch (e) { setSync('error'); toast('Échec : ' + (e.body?.message || e.message), 6000); }
}

/* ---------------- Init ---------------- */
function closeMenus(except) { $$('.menu-pop').forEach(p => { if (p !== except) p.classList.add('hidden'); }); }
function bindUi() {
  bindTable(); bindGuestDialog();
  $('#btn-add').onclick = () => openGuestDialog(null);
  $('#btn-logout').onclick = logout;
  $('#event-select').onchange = e => openEvent(e.target.value).catch(err => toast(err.message));
  $('#btn-new-event').onclick = () => openEventDialog(true);
  $('#btn-edit-event').onclick = () => openEventDialog(false);
  $('#e-pj-list').addEventListener('click', e => { const i = e.target.dataset.rmPj; if (i !== undefined) { dlgAtts.splice(+i, 1); renderDlgAtts(); } });
  $('#dlg-event').addEventListener('close', () => { if ($('#dlg-event').returnValue === 'ok') saveEventDialog(); });
  for (const [btn, pop] of [['#btn-share', '#share-pop'], ['#btn-more', '#more-pop']]) {
    $(btn).onclick = e => { e.stopPropagation(); const p = $(pop); closeMenus(p); p.classList.toggle('hidden'); };
  }
  document.addEventListener('click', () => closeMenus());
  $$('[data-share]').forEach(b => b.onclick = () => openShare(b.dataset.share));
  ['#sh-comments', '#sh-pending', '#sh-company'].forEach(s => $(s).onchange = () => { $('#share-text').value = buildShareText(state.shareMode); });
  $('#btn-copy').onclick = async () => {
    try { await navigator.clipboard.writeText($('#share-text').value); } catch { $('#share-text').select(); document.execCommand('copy'); }
    toast('Copié ! Collez-le dans ' + (state.shareMode === 'whatsapp' ? 'WhatsApp' : 'Teams') + '.');
  };
  $('#btn-export').onclick = exportExcel;
  $('#btn-template').onclick = downloadTemplate;
  $('#btn-zip').onclick = downloadAllEml;
  $('#btn-import').onclick = () => $('#file-import').click();
  $('#file-import').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) startImport(f).catch(err => toast(err.message)); };
  $('#dlg-import').addEventListener('close', () => { if ($('#dlg-import').returnValue === 'ok') applyImport($('input[name=imode]:checked').value); else state.pendingImport = null; });
  $('#btn-contacts').onclick = async () => { await renderContactsDialog(); $('#c-status').textContent = ''; $('#dlg-contacts').showModal(); };
  $('#c-file').onchange = e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    const soc = $('#c-societe').value.trim(); if (!soc) { $('#c-status').textContent = 'Indiquez d’abord la société de cette base.'; return; }
    importContacts(f, soc).catch(err => { $('#c-status').textContent = 'Erreur : ' + err.message; });
  };
  $('#contacts-list').addEventListener('click', async e => { const k = e.target.dataset.delBase; if (k && confirm(`Supprimer la base ${k} de ce navigateur ?`)) { await contactsDb.del(k); renderContactsDialog(); } });
  $('#btn-fill-emails').onclick = () => fillEmailsFromContacts(false);
}

async function start() {
  bindUi();
  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault(); $('#login-error').classList.add('hidden');
    try {
      await login($('#login-token').value.trim(), $('#login-repo').value.trim(), $('#login-remember').checked);
      await boot();
    } catch (err) {
      const msg = err.status === 401 ? 'Token invalide ou expiré.' : err.status === 404 ? 'Dépôt introuvable ou non autorisé pour ce token.' : err.message;
      $('#login-error').textContent = msg; $('#login-error').classList.remove('hidden');
    }
  });
  const token = store.get(LS.token), repo = store.get(LS.repo);
  if (token && repo) {
    state.token = token; state.repo = repo;
    try { await boot(); return; } catch (e) { if (e.status === 401) store.del(LS.token); }
  }
  $('#login').classList.remove('hidden');
}
async function boot() {
  await loadEvents();
  loadContacts();
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  if (!state.events.length) { openEventDialog(true); return; }
  const last = store.get(LS.event);
  await openEvent(state.events.some(e => e.id === last) ? last : state.events[0].id);
  setSync('ok');
}
start();
