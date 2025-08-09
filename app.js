// Jedi Practices Randomizer (serverless)
// Data model ---------------------------------------------------------------
/** @typedef {{ id:string, title:string, description:string, imageUrl?:string, weight:number, excluded:boolean }} Practice */
/** @typedef {{ id:string, name:string, practices:Practice[], created:number, updated:number, version:number }} Config */

const STORAGE_KEYS = {
  configs: 'jedi.configs.v1',
  activeId: 'jedi.activeConfigId.v1',
};
const BUILD_TAG = 'v2025-08-08-1';

// Utils -------------------------------------------------------------------
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const clamp = (v,min,max)=>Math.max(min,Math.min(max,v));
const byId = (id)=>document.getElementById(id);
const qs = (sel,root=document)=>root.querySelector(sel);
const qsa = (sel,root=document)=>[...root.querySelectorAll(sel)];
const fmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 });
const fmtPct = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 2 });

// Safe UTF-8 Base64 helpers ----------------------------------------------
function toBase64Utf8(str){
  try { return btoa(String.fromCharCode(...new TextEncoder().encode(str))); }
  catch { return btoa(unescape(encodeURIComponent(str))); }
}
function fromBase64Utf8(b64){
  try { return new TextDecoder().decode(Uint8Array.from(atob(b64), c=>c.charCodeAt(0))); }
  catch { return decodeURIComponent(escape(atob(b64))); }
}

function download(filename, data) {
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

// PRNG with seed -----------------------------------------------------------
function xmur3(str){ let h=1779033703^str.length; for(let i=0;i<str.length;i++){ h = Math.imul(h^str.charCodeAt(i), 3432918353); h = h<<13 | h>>>19; } return ()=>{ h = Math.imul(h ^ (h>>>16), 2246822507); h = Math.imul(h ^ (h>>>13), 3266489909); return (h ^= h>>>16) >>> 0; } }
function mulberry32(a){ return function(){ let t = a += 0x6D2B79F5; t = Math.imul(t ^ t>>>15, t | 1); t ^= t + Math.imul(t ^ t>>>7, t | 61); return ((t ^ t>>>14) >>> 0) / 4294967296; } }
function prngFromSeed(seed){ const h = xmur3(seed)(); return mulberry32(h); }
function todaySeed(){ const d = new Date(); const s = `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`; return s; }

async function fileToDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

// Persistence --------------------------------------------------------------
/** @returns {Config[]} */
function loadConfigs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.configs);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
/** @param {Config[]} configs */
function saveConfigs(configs) {
  localStorage.setItem(STORAGE_KEYS.configs, JSON.stringify(configs));
}
function getActiveId(){ return localStorage.getItem(STORAGE_KEYS.activeId) || ''; }
function setActiveId(id){ localStorage.setItem(STORAGE_KEYS.activeId, id); }

// Default config from markdown -------------------------------------------
async function loadDefaultConfigFromMarkdown() {
  const resp = await fetch('firstthreepract.md');
  const text = await resp.text();
  // Very light parser for the provided md format
  /** @type {Practice[]} */
  const practices = [];
  const lines = text.split(/\r?\n/);
  let current = null; let currentDesc = [];
  let imageFromLine = '';
  for (const line of lines) {
    const titleMatch = line.match(/^\s*\d+\.\s*(.+)$/);
    const imgMatch = line.match(/изображение.*?:\s*(.+)$/i);
    if (titleMatch) {
      if (current) {
        current.description = currentDesc.join('\n').trim();
        practices.push(current);
      }
      current = { id: uid(), title: titleMatch[1].trim(), description: '', weight: 1, excluded: false };
      currentDesc = [];
      continue;
    }
    if (imgMatch) {
      imageFromLine = imgMatch[1].trim();
      if (current) current.imageUrl = imageFromLine;
      continue;
    }
    if (current) currentDesc.push(line.replace(/^\s{4}/, ''));
  }
  if (current) { current.description = currentDesc.join('\n').trim(); practices.push(current); }

  const now = Date.now();
  /** @type {Config} */
  const cfg = { id: uid(), name: 'Базовый конфиг', practices, created: now, updated: now, version: 1 };
  return cfg;
}

// State -------------------------------------------------------------------
/** @type {Config[]} */ let CONFIGS = [];
/** @type {Config | null} */ let ACTIVE = null;

// UI Elements --------------------------------------------------------------
const elConfigSelect = byId('config-select');
const elConfigName = byId('config-name');
const elList = byId('practices-list');
const elProbCanvas = byId('prob-canvas');
const elBtnGenerate = byId('btn-generate');
const elToggleExcluded = byId('toggle-excluded');
const elSeedLock = byId('seed-lock');
const elSeedInput = byId('seed-input');
const elSeedToday = byId('seed-today');
const elTotalWeight = byId('total-weight');
const elRandValue = byId('rand-value');
const elPickedTitle = byId('picked-title');
const elResult = byId('result');
const elResultImg = byId('result-img');
const elResultTitle = byId('result-title');
const elResultDesc = byId('result-desc');
const elFx = byId('fx-canvas');
const elSearch = byId('search');
const elLogTable = byId('log-table');
const elToasts = byId('toasts');

const elDlg = byId('dlg-practice');
const elForm = byId('practice-form');
const elImgFile = byId('img-file');

const ghLink = byId('gh-link');

// Renderers ---------------------------------------------------------------
function renderConfigOptions() {
  elConfigSelect.innerHTML = '';
  for (const c of CONFIGS) {
    const opt = document.createElement('option');
    opt.value = c.id; opt.textContent = c.name;
    elConfigSelect.appendChild(opt);
  }
  if (ACTIVE) { elConfigSelect.value = ACTIVE.id; elConfigName.value = ACTIVE.name; }
}

function practiceItem(practice, index) {
  const tpl = byId('practice-item-tpl');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.dataset.id = practice.id;
  const title = qs('.title', node);
  const exclude = qs('.exclude', node);
  const weight = qs('.weight', node);
  const percent = qs('.percent', node);
  const btnEdit = qs('.btn-edit', node);
  const btnDelete = qs('.btn-delete', node);
  const btnExpand = qs('.btn-expand', node);
  const details = qs('.details', node);
  const desc = qs('.desc', node);
  const thumb = qs('.thumb', node);

  // Accessibility hookup for expandable details
  const detailsId = `det-${practice.id}`;
  details.id = detailsId;
  btnExpand.setAttribute('aria-controls', detailsId);
  btnExpand.setAttribute('aria-expanded', 'false');

  title.value = practice.title;
  exclude.checked = practice.excluded;
  weight.value = String(practice.weight);
  desc.textContent = practice.description || '';
  if (practice.imageUrl) { thumb.src = practice.imageUrl; node.classList.add('has-image'); }

  title.addEventListener('input', () => { practice.title = title.value; touch(); });
  exclude.addEventListener('change', () => { practice.excluded = exclude.checked; touch(); drawProbBar(); updatePercents(); });
  weight.addEventListener('input', () => { practice.weight = clamp(parseFloat(weight.value)||0, 0, 1e6); weight.value = String(practice.weight); touch(); drawProbBar(); updatePercents(); });
  

  btnEdit.addEventListener('click', () => openPracticeDialog(practice));
  btnDelete.addEventListener('click', () => deletePractice(practice.id));
  btnExpand.addEventListener('click', () => { const isOpen = node.classList.toggle('open'); btnExpand.setAttribute('aria-expanded', String(isOpen)); });

  // Drag & drop reordering
  node.addEventListener('dragstart', (e)=>{ e.dataTransfer.setData('text/plain', practice.id); node.classList.add('dragging'); });
  node.addEventListener('dragend', ()=> node.classList.remove('dragging')); 
  node.addEventListener('dragover', (e)=>{ e.preventDefault(); node.classList.add('drag-over'); });
  node.addEventListener('dragleave', ()=> node.classList.remove('drag-over'));
  node.addEventListener('drop', (e)=>{
    e.preventDefault(); node.classList.remove('drag-over');
    const fromId = e.dataTransfer.getData('text/plain');
    if (!fromId || fromId === practice.id) return;
    const fromIdx = ACTIVE.practices.findIndex(p=>p.id===fromId);
    const toIdx = ACTIVE.practices.findIndex(p=>p.id===practice.id);
    if (fromIdx<0 || toIdx<0) return;
    const [moved] = ACTIVE.practices.splice(fromIdx,1);
    ACTIVE.practices.splice(toIdx,0,moved);
    touch(); renderPractices();
  });

  // Image replace via drag
  node.addEventListener('dragover', (e)=>{
    if ([...e.dataTransfer.items].some(it=>it.kind==='file')) e.preventDefault();
  });
  node.addEventListener('drop', async (e)=>{
    const file = [...e.dataTransfer.files][0]; if (!file) return;
    const url = await fileToDataURL(file); practice.imageUrl = url; touch(); renderPractices();
  });

  // Percent fill later via updatePercents
  return node;
}

function renderPractices() {
  elList.innerHTML = '';
  if (!ACTIVE) return;
  const q = (elSearch.value||'').toLowerCase();
  const filtered = ACTIVE.practices.filter(p=> !q || p.title.toLowerCase().includes(q) || (p.description||'').toLowerCase().includes(q));
  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = `<div><strong>Ничего не найдено</strong><div class="row"><button class="ghost" id="btn-clear-search">Сбросить поиск</button><button class="primary" id="btn-empty-add">Добавить практику</button></div></div>`;
    elList.appendChild(empty);
    qs('#btn-clear-search', empty).addEventListener('click', ()=>{ elSearch.value=''; renderPractices(); });
    qs('#btn-empty-add', empty).addEventListener('click', ()=> openPracticeDialog());
  } else {
    for (const p of filtered) elList.appendChild(practiceItem(p));
  }
  drawProbBar();
  updatePercents();
}

function touch() { if (!ACTIVE) return; ACTIVE.updated = Date.now(); saveActiveToStore(); }

function saveActiveToStore() {
  const idx = CONFIGS.findIndex(c=>c.id===ACTIVE.id);
  if (idx>=0) CONFIGS[idx] = ACTIVE; else CONFIGS.push(ACTIVE);
  saveConfigs(CONFIGS);
}

function deletePractice(id) {
  if (!ACTIVE) return;
  ACTIVE.practices = ACTIVE.practices.filter(p=>p.id!==id);
  touch(); renderPractices();
}

// Dialog for add/edit ------------------------------------------------------
let editingPractice = null;
function openPracticeDialog(practice=null) {
  editingPractice = practice;
  qs('[name=title]', elForm).value = practice?.title || '';
  qs('[name=weight]', elForm).value = String(practice?.weight ?? 1);
  qs('[name=description]', elForm).value = practice?.description || '';
  qs('[name=imageUrl]', elForm).value = practice?.imageUrl || '';
  byId('dlg-title').textContent = practice ? 'Редактировать практику' : 'Новая практика';
  elDlg.showModal();
}

elForm.addEventListener('submit', e => e.preventDefault());
elForm.addEventListener('close', () => {
  if (elDlg.returnValue !== 'ok') return;
  const title = qs('[name=title]', elForm).value.trim(); if (!title) return;
  const weight = clamp(parseFloat(qs('[name=weight]', elForm).value)||1,0,1e6);
  const description = qs('[name=description]', elForm).value.trim();
  const imageUrl = qs('[name=imageUrl]', elForm).value.trim();
  const patch = { title, weight, description, imageUrl: imageUrl || undefined };
  if (editingPractice) Object.assign(editingPractice, patch);
  else ACTIVE.practices.push({ id: uid(), excluded: false, ...patch });
  editingPractice = null; touch(); renderPractices();
});

elImgFile.addEventListener('change', async () => {
  const f = elImgFile.files?.[0]; if (!f) return;
  const dataUrl = await fileToDataURL(f);
  qs('[name=imageUrl]', elForm).value = dataUrl;
});

byId('btn-add').addEventListener('click', () => openPracticeDialog());

// Probability bar + transparency -----------------------------------------
function getEffectivePractices() {
  if (!ACTIVE) return [];
  const excludeFlag = elToggleExcluded.checked;
  return ACTIVE.practices.filter(p => !excludeFlag || !p.excluded).filter(p => (p.weight ?? 0) > 0);
}

function updatePercents() {
  if (!ACTIVE) return;
  const list = getEffectivePractices();
  const total = list.reduce((s,p)=>s+(p.weight||0),0);
  const map = new Map(list.map(p=>[p.id,(p.weight||0)/ (total||1)]));
  qsa('.practice-item').forEach(node=>{
    const id = node.dataset.id; const percent = qs('.percent', node);
    const val = map.get(id) ?? 0;
    if (percent) percent.textContent = total? fmtPct.format(val): '—%';
  });
}

// Canvas DPR scaling -------------------------------------------------------
function ensureCanvasSize(canvas){
  const dpr = (window.devicePixelRatio||1);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  return { W: w, H: h, DPR: dpr };
}

// Seed UI state sync -------------------------------------------------------
function syncSeedUI(){
  const locked = elSeedLock.checked;
  // enable/disable seed inputs
  elSeedToday.disabled = !locked;
  elSeedInput.disabled = !locked || elSeedToday.checked;
  if (locked && elSeedToday.checked) elSeedInput.value = todaySeed();
}

function drawProbBar(pickedId=null, rValue=null) {
  const ctx = /** @type {HTMLCanvasElement} */ (elProbCanvas).getContext('2d');
  const { W, H } = ensureCanvasSize(elProbCanvas);
  ctx.clearRect(0,0,W,H);
  const list = getEffectivePractices();
  const total = list.reduce((s,p)=>s+(p.weight||0), 0);
  elTotalWeight.textContent = total ? fmt.format(total) : '—';
  if (!total) return;
  let x = 0;
  for (const p of list) {
    const w = (p.weight/total)*W;
    ctx.fillStyle = colorForId(p.id);
    roundRect(ctx, x+1, 6, Math.max(0, w-2), H-12, 10);
    ctx.fill();
    if (pickedId===p.id) {
      ctx.save(); ctx.globalAlpha=.25; ctx.fillStyle='#fff'; roundRect(ctx, x+1, 6, Math.max(0, w-2), H-12, 10); ctx.fill(); ctx.restore();
    }
    x += w;
  }
  if (rValue!=null) {
    const xr = rValue*W; ctx.strokeStyle = '#fff8'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(xr,0); ctx.lineTo(xr,H); ctx.stroke();
  }
}

function colorForId(id) {
  // Stable pastel from id
  let h = 0; for (let i=0;i<id.length;i++) h = (h*31 + id.charCodeAt(i)) >>> 0;
  const hue = h%360; return `hsl(${hue} 60% 55% / .9)`;
}

function roundRect(ctx, x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }

function weightedPick(list, rng=Math.random) {
  const total = list.reduce((s,p)=>s+(p.weight||0),0);
  const r = rng()*total;
  let acc = 0;
  for (const p of list) { acc += p.weight||0; if (r < acc) return { picked: p, r, total }; }
  return { picked: list[list.length-1], r: total, total };
}

function showResult(practice, r, total) {
  elRandValue.textContent = fmt.format(r) + ' / ' + fmt.format(total);
  elPickedTitle.textContent = practice.title;
  elResultTitle.textContent = practice.title;
  elResultDesc.textContent = practice.description || '';
  if (practice.imageUrl) {
    elResultImg.src = practice.imageUrl; elResultImg.alt = practice.title || '';
    elResultImg.onerror = () => { elResultImg.removeAttribute('src'); elResultImg.style.display = 'none'; };
    elResultImg.style.display = '';
  }
  else { elResultImg.removeAttribute('src'); elResultImg.style.display = 'none'; }
  elResult.classList.remove('hidden');
}

async function animateRoll(list) {
  // Simple suspense animation: sweep a marker across the prob bar a few times with easing
  const duration = 900; const extra = 2; // laps
  const start = performance.now();
  // Respect reduced motion
  try { if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return Promise.resolve(); } catch {}
  return new Promise(res => {
    const frame = (t) => {
      const dt = clamp((t-start)/(duration), 0, 1);
      const ease = 1 - Math.pow(1-dt, 3);
      const cycle = ease*(1+extra) % 1;
      drawProbBar(null, cycle);
      if (dt>=1) res(null); else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

elBtnGenerate.addEventListener('click', async () => {
  if (!ACTIVE) return;
  elResult.classList.add('hidden');
  const list = getEffectivePractices();
  if (!list.length) return;
  await animateRoll(list);
  const rng = (elSeedLock.checked ? prngFromSeed(elSeedInput.value || (elSeedToday.checked? todaySeed(): 'seed')) : Math.random);
  const { picked, r, total } = weightedPick(list, rng);
  drawProbBar(picked.id, r/total);
  showResult(picked, r, total);
  logProtocol(picked, r, total, list);
  confetti();
});

elToggleExcluded.addEventListener('change', () => drawProbBar());
elSeedLock.addEventListener('change', syncSeedUI);
elSeedToday.addEventListener('change', syncSeedUI);
elSearch.addEventListener('input', renderPractices);
// sync initial seed input state
syncSeedUI();
// re-draw bar on resize to keep crisp lines
window.addEventListener('resize', () => drawProbBar());

// Config controls ----------------------------------------------------------
byId('btn-save').addEventListener('click', () => {
  if (!ACTIVE) return;
  const btn = byId('btn-save');
  ACTIVE.name = elConfigName.value || 'Без названия';
  touch();
  renderConfigOptions();
  // brief visual confirmation
  const prev = btn.textContent;
  btn.textContent = 'Сохранено';
  btn.disabled = true;
  setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 1200);
});
byId('btn-save-as').addEventListener('click', () => {
  if (!ACTIVE) return;
  const suggested = (elConfigName.value || ACTIVE.name || 'Копия') + ' (копия)';
  const newName = prompt('Имя нового конфига:', suggested);
  if (newName === null) return; // cancelled
  const now = Date.now();
  const clone = JSON.parse(JSON.stringify(ACTIVE));
  clone.id = uid(); clone.name = (newName.trim() || suggested); clone.created = now; clone.updated = now;
  CONFIGS.push(clone); ACTIVE = clone; setActiveId(ACTIVE.id); saveConfigs(CONFIGS); renderConfigOptions(); renderPractices();
});
byId('btn-delete').addEventListener('click', () => {
  if (!ACTIVE) return;
  if (!confirm('Удалить текущий конфиг?')) return;
  CONFIGS = CONFIGS.filter(c=>c.id!==ACTIVE.id);
  saveConfigs(CONFIGS);
  if (CONFIGS.length) { ACTIVE = CONFIGS[0]; setActiveId(ACTIVE.id); }
  else { ACTIVE = null; setActiveId(''); }
  renderConfigOptions(); renderPractices();
});
byId('btn-reset').addEventListener('click', async () => {
  if (!confirm('Сбросить к базовому конфигу?')) return;
  const base = await loadDefaultConfigFromMarkdown();
  ACTIVE = base; setActiveId(base.id); saveConfigs([base]); CONFIGS = [base];
  renderConfigOptions(); renderPractices();
});

elConfigSelect.addEventListener('change', () => {
  const id = elConfigSelect.value; const c = CONFIGS.find(x=>x.id===id);
  if (c) { ACTIVE = c; setActiveId(c.id); elConfigName.value = c.name; renderPractices(); }
});

byId('btn-export').addEventListener('click', () => {
  if (!ACTIVE) return;
  const data = JSON.stringify(ACTIVE, null, 2);
  download(`${ACTIVE.name || 'config'}.json`, data);
});

byId('file-import').addEventListener('change', async (e) => {
  const file = e.target.files?.[0]; if (!file) return;
  const text = await file.text();
  try {
    /** @type {Config} */
    const cfg = JSON.parse(text);
    if (!cfg.id) cfg.id = uid();
    cfg.created ||= Date.now(); cfg.updated = Date.now(); cfg.version ||= 1;
    CONFIGS.push(cfg); ACTIVE = cfg; setActiveId(cfg.id); saveConfigs(CONFIGS);
    renderConfigOptions(); renderPractices();
    toast('Импортировано', 'success');
  } catch { toast('Не удалось импортировать файл', 'error'); }
  e.target.value = '';
});

// Markdown import ----------------------------------------------------------
byId('md-import').addEventListener('change', async (e) => {
  const file = e.target.files?.[0]; if (!file) return;
  const text = await file.text();
  const cfg = await parseMarkdownToConfig(text, file.name.replace(/\.md$/i,''));
  CONFIGS.push(cfg); ACTIVE = cfg; setActiveId(cfg.id); saveConfigs(CONFIGS);
  renderConfigOptions(); renderPractices();
  e.target.value = '';
});

async function parseMarkdownToConfig(text, name='Импорт из MD'){
  /** @type {Practice[]} */
  const practices = [];
  const lines = text.split(/\r?\n/);
  let current=null, buf=[]; let image='';
  for (const line of lines) {
    const t = line.match(/^\s*\d+\.\s*(.+)$/);
    const im = line.match(/изображение.*?:\s*(.+)$/i);
    if (t) {
      if (current) { current.description = buf.join('\n').trim(); practices.push(current); }
      current = { id: uid(), title: t[1].trim(), description: '', weight: 1, excluded: false };
      if (image) { current.imageUrl = image; image=''; }
      buf=[]; continue;
    }
    if (im) { image = im[1].trim(); if (current) current.imageUrl = image; continue; }
    if (current) buf.push(line.replace(/^\s{4}/,''));
  }
  if (current) { current.description = buf.join('\n').trim(); practices.push(current); }
  const now = Date.now();
  return { id: uid(), name, practices, created: now, updated: now, version: 1 };
}

// Shareable URL ------------------------------------------------------------
byId('btn-share').addEventListener('click', async ()=>{
  if (!ACTIVE) return;
  // omit inlined data-URL images to keep link short
  const copy = JSON.parse(JSON.stringify(ACTIVE));
  let removed = 0;
  copy.practices = copy.practices.map(p=>{
    const q = { ...p };
    if (q.imageUrl && /^data:/i.test(q.imageUrl)) { delete q.imageUrl; removed++; }
    return q;
  });
  const data = toBase64Utf8(JSON.stringify(copy));
  const url = new URL(location.href); url.hash = `#cfg=${data}`;
  const text = url.toString();
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      toast(removed? `Ссылка скопирована (изображений удалено: ${removed})` : 'Ссылка скопирована', 'info');
      return;
    }
    throw new Error('Clipboard API недоступен');
  } catch {
    // Fallback: selection prompt
    prompt('Скопируйте ссылку вручную:', text);
    toast(removed? `Ссылка готова (изображений удалено: ${removed})` : 'Ссылка готова', 'info');
  }
});

function tryLoadFromHash(){
  const m = location.hash.match(/#cfg=([^&]+)/);
  if (!m) return false;
  try {
    const cfg = JSON.parse(fromBase64Utf8(m[1]));
    if (!cfg.id) cfg.id = uid(); cfg.created ||= Date.now(); cfg.updated ||= Date.now(); cfg.version ||= 1;
    CONFIGS.push(cfg); ACTIVE = cfg; setActiveId(cfg.id); saveConfigs(CONFIGS);
    return true;
  } catch {}
  return false;
}

// Protocol log -------------------------------------------------------------
function logProtocol(picked, r, total, list){
  if (!elLogTable) return;
  const tbody = elLogTable.querySelector('tbody');
  const row = document.createElement('tr');
  const time = new Date().toLocaleTimeString();
  let acc=0; let range='';
  for (const p of list){ const prev=acc; acc += p.weight||0; if (p.id===picked.id){ range = `[${fmt.format(prev)}; ${fmt.format(acc)}]`; break; } }
  row.innerHTML = `<td>${time}</td><td>${fmt.format(r)} / ${fmt.format(total)}</td><td>${picked.title}</td><td>${range}</td>`;
  tbody.prepend(row);
}

// Clear protocol log
byId('btn-clear-log').addEventListener('click', ()=>{
  if (!elLogTable) return;
  const tbody = elLogTable.querySelector('tbody');
  tbody.innerHTML = '';
  toast('Протокол очищен', 'info');
});

// Toasts ------------------------------------------------------------------
function toast(message, type='info'){
  if (!elToasts) return alert(message);
  const div = document.createElement('div');
  div.className = `toast ${type}`;
  div.textContent = message;
  elToasts.appendChild(div);
  setTimeout(()=> div.remove(), 2300);
}

// Keyboard shortcuts ------------------------------------------------------
window.addEventListener('keydown', (e)=>{
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  // g: generate
  if (e.key.toLowerCase()==='g') { byId('btn-generate').click(); e.preventDefault(); }
  // n: new practice
  if (e.key.toLowerCase()==='n') { openPracticeDialog(); e.preventDefault(); }
  // s: save config
  if (e.key.toLowerCase()==='s') { byId('btn-save').click(); e.preventDefault(); }
  // /: focus search
  if (e.key === '/') { elSearch.focus(); elSearch.select(); e.preventDefault(); }
  // ?: help
  if (e.key === '?') { toast('Сочетания: G — генерировать, N — новая, S — сохранить, / — поиск, ? — помощь', 'info'); e.preventDefault(); }
});

// Confetti FX --------------------------------------------------------------
function confetti(){
  // Respect reduced motion preferences
  try { if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return; } catch {}
  const c = /** @type {HTMLCanvasElement} */ (elFx); if (!c) return; const ctx = c.getContext('2d');
  const DPR = (window.devicePixelRatio||1); const W = c.width = innerWidth*DPR; const H = c.height = innerHeight*DPR; c.style.display='block';
  const N = 120; const parts = Array.from({length:N}, (_,i)=>({x:Math.random()*W,y:-Math.random()*H,vx:(Math.random()-.5)*0.6,vy:Math.random()*2+1, r: (Math.random()*6+3)*DPR, a: Math.random()*Math.PI*2, col:`hsl(${(i*21)%360} 80% 60%)`}));
  let t0=null; function frame(ts){ if(!t0) t0=ts; const dt=(ts-t0)/16; t0=ts; ctx.clearRect(0,0,W,H); let alive=false; parts.forEach(p=>{ p.x+=p.vx*dt; p.y+=p.vy*dt; p.vy+=0.02*dt; p.a+=0.1*dt; ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.a); ctx.fillStyle=p.col; ctx.fillRect(-p.r/2,-p.r/2,p.r,p.r); ctx.restore(); if (p.y<H+40*DPR) alive=true; }); if (alive) requestAnimationFrame(frame); else c.style.display='none'; }
  requestAnimationFrame(frame);
}

// Init --------------------------------------------------------------------
async function init() {
  // Build banner
  try { console.log(`%cJedi Praktiki ${BUILD_TAG}`, 'background:#111;color:#0f0;padding:2px 6px;border-radius:4px'); } catch {}
  // GH link autodetect
  try {
    let href = '#';
    if (location.hostname.endsWith('github.io')) {
      const user = location.hostname.split('.')[0];
      const seg = location.pathname.replace(/^\/?|\/?$/g,'').split('/')[0];
      href = seg ? `https://github.com/${user}/${seg}` : `https://github.com/${user}`;
    } else {
      href = `https://github.com/search?q=${encodeURIComponent(location.host + location.pathname)}&type=code`;
    }
    ghLink.href = href;
  } catch {}

  CONFIGS = loadConfigs();
  const storedActive = getActiveId();
  if (!CONFIGS.length && !tryLoadFromHash()) {
    const base = await loadDefaultConfigFromMarkdown();
    CONFIGS = [base]; ACTIVE = base; setActiveId(base.id); saveConfigs(CONFIGS);
  } else {
    ACTIVE = CONFIGS.find(c=>c.id===storedActive) || CONFIGS[0];
  }
  renderConfigOptions(); renderPractices();

  // PWA SW
  if ('serviceWorker' in navigator) {
    try { navigator.serviceWorker.register('sw.js'); } catch {}
  }
}

init();
