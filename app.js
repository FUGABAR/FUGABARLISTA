// ==========================================================================
// Lista da Casa — lógica do app (Firebase Firestore + Auth anônima)
// ==========================================================================
import { firebaseConfig } from "./firebase-config.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, addDoc, getDocs, onSnapshot
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const fdb = getFirestore(app);

// ---------------- helpers ----------------
const $ = (id) => document.getElementById(id);
const norm = (s) => (s || "").toString().normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const show = (el, on) => { el.hidden = !on; };
const fmtDate = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};
function toast(msg) {
  const root = $("toast-root");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  root.innerHTML = "";
  root.appendChild(el);
  setTimeout(() => { el.remove(); }, 2200);
}
function closeModal() { $("modal-root").innerHTML = ""; }
function openModal(html) {
  $("modal-root").innerHTML = `<div class="modal-bg" id="modal-bg"><div class="modal">${html}</div></div>`;
  $("modal-bg").addEventListener("click", (e) => { if (e.target.id === "modal-bg") closeModal(); });
}
function escapeHtml(s) {
  return (s || "").toString().replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------- name & phone parsing ----------------
const LOWER_WORDS = new Set(["de", "da", "do", "das", "dos", "e", "di", "du"]);
function titleCase(s) {
  return (s || "").toString().trim().toLowerCase().split(/\s+/).map((w, i) => {
    if (!w) return w;
    if (i > 0 && LOWER_WORDS.has(w)) return w;
    return w.split("-").map((seg) => (seg ? seg.charAt(0).toUpperCase() + seg.slice(1) : seg)).join("-");
  }).join(" ");
}
function isPhoneLike(s) {
  const str = (s || "").toString().trim();
  if (!str) return false;
  const digits = str.replace(/\D/g, "");
  return digits.length >= 8 && !/[a-zA-ZÀ-ÿ]/.test(str);
}
function formatPhone(raw) {
  let digits = (raw || "").toString().replace(/\D/g, "");
  if (digits.length >= 12 && digits.startsWith("55")) digits = digits.slice(2);
  while (digits.length > 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 8) return digits.slice(0, 4) + "-" + digits.slice(4);
  if (digits.length === 9) return digits.slice(0, 5) + "-" + digits.slice(5);
  if (digits.length === 10) return digits.slice(0, 2) + " " + digits.slice(2, 6) + "-" + digits.slice(6);
  if (digits.length === 11) return digits.slice(0, 2) + " " + digits.slice(2, 7) + "-" + digits.slice(7);
  return digits || (raw || "").toString().trim();
}
function stripListNumbering(line) {
  const m = line.match(/^(\d{1,3})[.)\-:]?\s+(.+)$/);
  if (m && /[a-zA-ZÀ-ÿ]/.test(m[2])) return m[2].trim();
  return line;
}
function extractPhoneFromLine(line) {
  let parts = line.split(" - ").map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1 && isPhoneLike(parts[parts.length - 1])) {
    return { name: parts.slice(0, -1).join(" - ").trim(), telefone: parts[parts.length - 1] };
  }
  const m = line.match(/^(.*\S)\s+(\+?\d[\d\s()\-]{6,}\d)$/);
  if (m && /[a-zA-ZÀ-ÿ]/.test(m[1])) {
    return { name: m[1].trim(), telefone: m[2].trim() };
  }
  return { name: line.trim(), telefone: "" };
}
function parseBulkLines(rawText) {
  const lines = rawText.split("\n").map((l) => l.trim()).filter(Boolean);
  const results = [];
  for (const rawLine of lines) {
    const line = stripListNumbering(rawLine);
    if (isPhoneLike(line)) {
      if (results.length && !results[results.length - 1].telefone) {
        results[results.length - 1].telefone = formatPhone(line);
      }
      continue;
    }
    const { name, telefone } = extractPhoneFromLine(line);
    if (!name) continue;
    results.push({ nome: titleCase(name), telefone: telefone ? formatPhone(telefone) : "" });
  }
  return results;
}
// Separa nomes novos de duplicados (comparando sem acento/maiúsculas) contra
// a lista já existente no evento e dentro do próprio lote colado.
function dedupAndMerge(newEntries, existingGuests) {
  const existingByKey = {};
  existingGuests.forEach((g) => { existingByKey[norm(g.nome)] = g; });
  const batchByKey = {};
  const toCreate = [];
  const toUpdatePhone = [];
  let duplicates = 0;
  for (const entry of newEntries) {
    const key = norm(entry.nome);
    if (!key) continue;
    if (existingByKey[key]) {
      duplicates++;
      const existing = existingByKey[key];
      if (entry.telefone && !existing.telefone) {
        toUpdatePhone.push({ id: existing.id, telefone: entry.telefone });
        existing.telefone = entry.telefone;
      }
      continue;
    }
    if (batchByKey[key]) {
      duplicates++;
      if (entry.telefone && !batchByKey[key].telefone) batchByKey[key].telefone = entry.telefone;
      continue;
    }
    batchByKey[key] = entry;
    toCreate.push(entry);
  }
  return { toCreate, toUpdatePhone, duplicates };
}

// ---------------- state ----------------
let role = null; // 'admin' | 'operator'
let pins = { operatorPin: "0000" };
let socios = []; // [{id, nome, pin}]
let currentAdminId = null;
let currentAdminName = null;
let events = [];
let pastEvents = [];
let currentOperatorEventId = null;
let currentAdminEventId = null;
let guestsCache = {};
let unsubGuests = {};
let socioSeedAttempted = false;

const LS_ROLE = "vip_role_v1";
const LS_ADMIN_ID = "vip_admin_id_v1";

// ---------------- boot: anonymous auth then live data ----------------
onAuthStateChanged(auth, (user) => {
  if (user) startApp();
});
signInAnonymously(auth).catch((err) => {
  console.error("Erro no login anônimo:", err);
  $("loading-screen").textContent = "Não foi possível conectar. Confira firebase-config.js e as regras do Firestore.";
});

let started = false;
function startApp() {
  if (started) return;
  started = true;

  const pinsRef = doc(fdb, "config", "pins");
  getDoc(pinsRef).then((snap) => {
    if (!snap.exists()) setDoc(pinsRef, pins).catch(() => {});
  });
  onSnapshot(pinsRef, (snap) => {
    if (snap.exists()) {
      pins = Object.assign({ operatorPin: "0000" }, snap.data());
      if (role === "admin") $("cfg-operator-pin").value = pins.operatorPin;
    }
  }, (e) => console.warn("pins error", e));

  onSnapshot(collection(fdb, "socios"), (qs) => {
    socios = qs.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    if (!socios.length && !socioSeedAttempted) {
      socioSeedAttempted = true;
      addDoc(collection(fdb, "socios"), { nome: "Administrador", pin: "1234", createdAt: Date.now() }).catch(() => {});
    }
    renderSocios();
    if (role === "admin" && currentAdminId) {
      const me = socios.find((s) => s.id === currentAdminId);
      if (me) { currentAdminName = me.nome; updateAdminNameUi(); }
      else { logout(); toast("Seu login de sócio foi removido."); }
    }
  }, (e) => console.warn("socios error", e));

  onSnapshot(collection(fdb, "events"), (qs) => {
    const all = qs.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    events = all.filter((e) => !e.archived).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    pastEvents = all.filter((e) => e.archived).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    renderEventsAdmin();
    renderPastEvents();
    renderOperatorEventOptions();
    if (currentAdminEventId) {
      const ev = events.find((e) => e.id === currentAdminEventId);
      if (ev) {
        $("detail-event-name").textContent = ev.name;
        $("detail-visible-toggle").checked = !!ev.operatorVisible;
      }
    }
  }, (e) => { console.warn("events error", e); toast("Erro ao carregar eventos."); });

  $("loading-screen").hidden = true;
  $("app").hidden = false;

  const savedRole = localStorage.getItem(LS_ROLE);
  const savedAdminId = localStorage.getItem(LS_ADMIN_ID);
  if (savedRole === "admin" && savedAdminId) {
    currentAdminId = savedAdminId;
    role = "admin";
    enterAdmin();
  } else if (savedRole === "operator") {
    enterOperator();
  }
}

function watchGuests(eventId) {
  if (unsubGuests[eventId]) return;
  unsubGuests[eventId] = onSnapshot(collection(fdb, "events", eventId, "guests"), (qs) => {
    guestsCache[eventId] = qs.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    if (currentOperatorEventId === eventId) renderOperatorList();
    if (currentAdminEventId === eventId) renderAdminGuestList();
  }, (e) => console.warn("guests error", e));
}

// ---------------- GATE ----------------
$("pin-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const val = $("pin-input").value.trim();
  const socio = val ? socios.find((s) => s.pin === val) : null;
  if (val && val === pins.operatorPin) {
    role = "operator"; localStorage.setItem(LS_ROLE, "operator");
    localStorage.removeItem(LS_ADMIN_ID);
    enterOperator();
  } else if (socio) {
    role = "admin"; currentAdminId = socio.id; currentAdminName = socio.nome;
    localStorage.setItem(LS_ROLE, "admin");
    localStorage.setItem(LS_ADMIN_ID, socio.id);
    enterAdmin();
  } else {
    $("gate-error").textContent = "Código inválido. Tente de novo.";
    $("pin-input").value = "";
  }
});

function enterOperator() {
  show($("screen-gate"), false);
  show($("screen-operator"), true);
  show($("screen-admin"), false);
  renderOperatorEventOptions();
}
function enterAdmin() {
  show($("screen-gate"), false);
  show($("screen-admin"), true);
  show($("screen-operator"), false);
  $("cfg-operator-pin").value = pins.operatorPin;
  updateAdminNameUi();
  renderEventsAdmin();
  renderSocios();
}
function updateAdminNameUi() {
  $("adm-current-name").textContent = currentAdminName ? "Logado como " + currentAdminName : "Administração";
  $("add-guest-as").textContent = currentAdminName || "—";
}
function logout() {
  role = null; currentAdminId = null; currentAdminName = null;
  localStorage.removeItem(LS_ROLE);
  localStorage.removeItem(LS_ADMIN_ID);
  $("pin-input").value = "";
  $("gate-error").textContent = "";
  show($("screen-operator"), false);
  show($("screen-admin"), false);
  show($("screen-gate"), true);
}
$("op-logout").addEventListener("click", logout);
$("adm-logout").addEventListener("click", logout);

// ---------------- OPERATOR ----------------
function renderOperatorEventOptions() {
  const sel = $("op-event-select");
  const visible = events.filter((e) => e.operatorVisible);
  const prev = currentOperatorEventId;
  sel.innerHTML = visible.length
    ? visible.map((e) => `<option value="${e.id}">${escapeHtml(e.name)} · ${fmtDate(e.date)}</option>`).join("")
    : `<option value="">Nenhum evento liberado</option>`;
  if (visible.find((e) => e.id === prev)) {
    sel.value = prev;
  } else if (visible.length) {
    currentOperatorEventId = visible[0].id;
    sel.value = currentOperatorEventId;
  } else {
    currentOperatorEventId = null;
  }
  if (currentOperatorEventId) watchGuests(currentOperatorEventId);
  renderOperatorList();
}
$("op-event-select").addEventListener("change", (e) => {
  currentOperatorEventId = e.target.value || null;
  if (currentOperatorEventId) watchGuests(currentOperatorEventId);
  renderOperatorList();
});
$("op-search").addEventListener("input", renderOperatorList);

function renderOperatorList() {
  const list = $("op-list");
  if (!currentOperatorEventId) {
    list.innerHTML = `<div class="empty">Peça pro ADM liberar um evento pra você ver a lista aqui.</div>`;
    $("stat-total").textContent = "0"; $("stat-in").textContent = "0"; $("stat-left").textContent = "0";
    return;
  }
  const guests = (guestsCache[currentOperatorEventId] || []).slice();
  const q = norm($("op-search").value);
  let filtered = guests.filter((g) => {
    if (!q) return true;
    return norm(g.nome).includes(q) || norm(g.telefone).includes(q) || norm(g.autorizadoPor).includes(q);
  });
  filtered.sort((a, b) => (a.nome || "").localeCompare(b.nome || "", "pt-BR", { sensitivity: "base" }));

  const total = guests.length;
  const inCount = guests.filter((g) => g.checkedIn).length;
  $("stat-total").textContent = total;
  $("stat-in").textContent = inCount;
  $("stat-left").textContent = total - inCount;

  if (!filtered.length) {
    list.innerHTML = `<div class="empty">${guests.length ? "Ninguém encontrado com essa busca." : "Lista vazia por enquanto."}</div>`;
    return;
  }

  let html = "";
  let lastLetter = "";
  const hasQuery = !!q;
  filtered.forEach((g) => {
    const letter = (g.nome || "?").trim().charAt(0).toUpperCase();
    if (!hasQuery && letter !== lastLetter) {
      html += `<div class="letter-head">${letter}</div>`;
      lastLetter = letter;
    }
    const meta = [];
    if (g.autorizadoPor) meta.push(`liberado por ${escapeHtml(g.autorizadoPor)}`);
    html += `
      <button class="guest ${g.checkedIn ? "checked" : ""}" data-id="${g.id}">
        <span class="guest-check">✓</span>
        <span class="guest-info">
          <span class="guest-name">${escapeHtml(g.nome)}</span>
          ${meta.length ? `<span class="guest-meta">${meta.map((m) => `<span class="tag">${m}</span>`).join("")}</span>` : ""}
        </span>
      </button>`;
  });
  list.innerHTML = html;
  list.querySelectorAll(".guest").forEach((btn) => {
    btn.addEventListener("click", () => onGuestClick(btn.dataset.id));
  });
}

function onGuestClick(guestId) {
  const guests = guestsCache[currentOperatorEventId] || [];
  const g = guests.find((x) => x.id === guestId);
  if (!g) return;
  if (!g.checkedIn) {
    // marcar entrada: direto, sem confirmação (fluxo rápido na porta)
    setCheckin(guestId, true);
  } else {
    // desmarcar: pede confirmação pra evitar toque sem querer
    openModal(`
      <h3>Desmarcar ${escapeHtml(g.nome)}?</h3>
      <p style="color:var(--text-dim); font-size:14px;">Essa pessoa está marcada como já entrou. Tem certeza que quer desmarcar a entrada dela?</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="cancel-uncheck">Cancelar</button>
        <button class="btn btn-danger" id="confirm-uncheck">Desmarcar</button>
      </div>
    `);
    $("cancel-uncheck").addEventListener("click", closeModal);
    $("confirm-uncheck").addEventListener("click", () => {
      closeModal();
      setCheckin(guestId, false);
    });
  }
}

function setCheckin(guestId, checkedIn) {
  const ref = doc(fdb, "events", currentOperatorEventId, "guests", guestId);
  updateDoc(ref, { checkedIn, checkedInAt: checkedIn ? new Date().toISOString() : null })
    .catch(() => toast("Erro ao atualizar."));
}

// ---------------- ADMIN: tabs ----------------
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const which = tab.dataset.tab;
    show($("tab-eventos"), which === "eventos");
    show($("event-detail"), false);
    show($("tab-passados"), which === "passados");
    show($("tab-config"), which === "config");
  });
});

$("create-event-btn").addEventListener("click", async () => {
  const name = $("new-event-name").value.trim();
  const date = $("new-event-date").value;
  if (!name) { toast("Dá um nome pro evento."); return; }
  await addDoc(collection(fdb, "events"), {
    name, date: date || new Date().toISOString().slice(0, 10),
    operatorVisible: false, archived: false, createdAt: Date.now()
  });
  $("new-event-name").value = ""; $("new-event-date").value = "";
  toast("Evento criado.");
});

function renderEventsAdmin() {
  const wrap = $("events-active-list");
  if (!events.length) { wrap.innerHTML = `<div class="empty">Nenhum evento ativo ainda.</div>`; return; }
  wrap.innerHTML = events.map((e) => `
    <div class="event-item">
      <div style="flex:1; min-width:0;">
        <div class="ename">${escapeHtml(e.name)}</div>
        <div class="esub">${fmtDate(e.date)} · ${(guestsCache[e.id] || []).length} na lista</div>
      </div>
      <label class="switch" title="Visível pro operador">
        <input type="checkbox" data-visible-toggle="${e.id}" ${e.operatorVisible ? "checked" : ""}>
        <span class="slider"></span>
      </label>
      <button class="btn btn-ghost btn-sm" data-open="${e.id}">Abrir</button>
    </div>
  `).join("");
  wrap.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openEventDetail(b.dataset.open)));
  wrap.querySelectorAll("[data-visible-toggle]").forEach((b) => b.addEventListener("change", () => {
    updateDoc(doc(fdb, "events", b.dataset.visibleToggle), { operatorVisible: b.checked }).catch(() => toast("Erro ao salvar."));
  }));
}

function openEventDetail(eventId) {
  currentAdminEventId = eventId;
  watchGuests(eventId);
  show($("tab-eventos"), false);
  show($("event-detail"), true);
  const ev = events.find((e) => e.id === eventId);
  $("detail-event-name").textContent = ev ? ev.name : "";
  $("detail-visible-toggle").checked = ev ? !!ev.operatorVisible : false;
  renderAdminGuestList();
}
$("back-to-events").addEventListener("click", () => {
  currentAdminEventId = null;
  show($("event-detail"), false);
  show($("tab-eventos"), true);
});
$("detail-visible-toggle").addEventListener("change", (e) => {
  if (!currentAdminEventId) return;
  updateDoc(doc(fdb, "events", currentAdminEventId), { operatorVisible: e.target.checked }).catch(() => toast("Erro ao salvar."));
});
$("close-event-btn").addEventListener("click", () => {
  if (!currentAdminEventId) return;
  openModal(`
    <h3>Encerrar este evento?</h3>
    <p style="color:var(--text-dim); font-size:14px;">Ele vai pra aba "Encerrados" e some da lista do operador. Você pode apagar de vez depois.</p>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="cancel-close">Cancelar</button>
      <button class="btn btn-danger" id="confirm-close">Encerrar evento</button>
    </div>
  `);
  $("cancel-close").addEventListener("click", closeModal);
  $("confirm-close").addEventListener("click", async () => {
    await updateDoc(doc(fdb, "events", currentAdminEventId), { archived: true, operatorVisible: false });
    closeModal(); toast("Evento encerrado.");
    currentAdminEventId = null;
    show($("event-detail"), false); show($("tab-eventos"), true);
  });
});

$("add-guest-btn").addEventListener("click", async () => {
  if (!currentAdminEventId) return;
  const nomeRaw = $("guest-nome").value.trim();
  if (!nomeRaw) { toast("Digita o nome."); return; }
  const nome = titleCase(nomeRaw);
  const telefoneRaw = $("guest-telefone").value.trim();
  const telefone = telefoneRaw ? formatPhone(telefoneRaw) : "";
  const existing = (guestsCache[currentAdminEventId] || []).find((g) => norm(g.nome) === norm(nome));
  if (existing) {
    if (telefone && !existing.telefone) {
      await updateDoc(doc(fdb, "events", currentAdminEventId, "guests", existing.id), { telefone });
      toast("Nome já existia — telefone atualizado.");
    } else {
      toast("Esse nome já está na lista.");
    }
    ["guest-nome", "guest-telefone"].forEach((id) => $(id).value = "");
    return;
  }
  const data = {
    nome, telefone,
    autorizadoPor: currentAdminName || "",
    checkedIn: false, checkedInAt: null, createdAt: Date.now()
  };
  await addDoc(collection(fdb, "events", currentAdminEventId, "guests"), data);
  ["guest-nome", "guest-telefone"].forEach((id) => $(id).value = "");
  toast("Adicionado.");
});

$("bulk-add-btn").addEventListener("click", async () => {
  if (!currentAdminEventId) return;
  const rawText = $("bulk-textarea").value;
  if (!rawText.trim()) { toast("Cola a lista primeiro."); return; }
  const parsed = parseBulkLines(rawText);
  if (!parsed.length) { toast("Não encontrei nomes nessa lista."); return; }
  const existingGuests = guestsCache[currentAdminEventId] || [];
  const { toCreate, toUpdatePhone, duplicates } = dedupAndMerge(parsed, existingGuests);
  const col = collection(fdb, "events", currentAdminEventId, "guests");
  for (const entry of toCreate) {
    await addDoc(col, { nome: entry.nome, telefone: entry.telefone, autorizadoPor: currentAdminName || "", checkedIn: false, checkedInAt: null, createdAt: Date.now() });
  }
  for (const upd of toUpdatePhone) {
    await updateDoc(doc(fdb, "events", currentAdminEventId, "guests", upd.id), { telefone: upd.telefone });
  }
  $("bulk-textarea").value = "";
  let msg = `${toCreate.length} nome(s) adicionado(s).`;
  if (duplicates) msg += ` ${duplicates} duplicado(s) ignorado(s).`;
  toast(msg);
});

function renderAdminGuestList() {
  if (!currentAdminEventId) return;
  const guests = (guestsCache[currentAdminEventId] || []).slice()
    .sort((a, b) => (a.nome || "").localeCompare(b.nome || "", "pt-BR", { sensitivity: "base" }));
  $("detail-guest-count").textContent = guests.length;
  const wrap = $("detail-guest-list");
  if (!guests.length) { wrap.innerHTML = `<div class="empty">Ninguém na lista ainda.</div>`; return; }
  wrap.innerHTML = guests.map((g) => `
    <div class="guest-row-admin">
      <div style="min-width:0;">
        <div class="g-name">${escapeHtml(g.nome)} ${g.checkedIn ? `<span class="tag" style="color:var(--good);">entrou</span>` : ""}</div>
        <div class="g-meta">${[g.autorizadoPor && `por ${escapeHtml(g.autorizadoPor)}`, g.telefone].filter(Boolean).join(" · ")}</div>
      </div>
      <div class="row-actions">
        <button class="iconbtn-sm" data-del="${g.id}" title="Remover">✕</button>
      </div>
    </div>
  `).join("");
  wrap.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
    openModal(`
      <h3>Remover da lista?</h3>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="cancel-del">Cancelar</button>
        <button class="btn btn-danger" id="confirm-del">Remover</button>
      </div>
    `);
    $("cancel-del").addEventListener("click", closeModal);
    $("confirm-del").addEventListener("click", async () => {
      await deleteDoc(doc(fdb, "events", currentAdminEventId, "guests", b.dataset.del));
      closeModal(); toast("Removido.");
    });
  }));
}

// ---------------- ADMIN: past events ----------------
function renderPastEvents() {
  const wrap = $("events-past-list");
  if (!pastEvents.length) { wrap.innerHTML = `<div class="empty">Nenhum evento encerrado ainda.</div>`; return; }
  wrap.innerHTML = pastEvents.map((e) => `
    <div class="event-item">
      <div style="flex:1; min-width:0;">
        <div class="ename">${escapeHtml(e.name)}</div>
        <div class="esub">${fmtDate(e.date)}</div>
      </div>
      <button class="btn btn-danger btn-sm" data-purge="${e.id}">Excluir</button>
    </div>
  `).join("");
  wrap.querySelectorAll("[data-purge]").forEach((b) => b.addEventListener("click", () => {
    openModal(`
      <h3>Excluir este evento pra sempre?</h3>
      <p style="color:var(--text-dim); font-size:14px;">Isso apaga o evento e todos os nomes da lista dele. Não dá pra desfazer.</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="cancel-purge">Cancelar</button>
        <button class="btn btn-danger" id="confirm-purge">Excluir de vez</button>
      </div>
    `);
    $("cancel-purge").addEventListener("click", closeModal);
    $("confirm-purge").addEventListener("click", async () => {
      const eventId = b.dataset.purge;
      const col = collection(fdb, "events", eventId, "guests");
      const guestsSnap = await getDocs(col);
      for (const d of guestsSnap.docs) { await deleteDoc(doc(fdb, "events", eventId, "guests", d.id)); }
      await deleteDoc(doc(fdb, "events", eventId));
      closeModal(); toast("Evento excluído.");
    });
  }));
}

// ---------------- ADMIN: sócios ----------------
function renderSocios() {
  const wrap = $("socios-list");
  if (!wrap) return;
  if (!socios.length) { wrap.innerHTML = `<div class="empty">Nenhum sócio cadastrado ainda.</div>`; return; }
  wrap.innerHTML = socios.map((s) => `
    <div class="guest-row-admin">
      <div style="min-width:0;">
        <div class="g-name">${escapeHtml(s.nome)} ${s.id === currentAdminId ? '<span class="tag">você</span>' : ""}</div>
        <div class="g-meta mono">código: ${escapeHtml(s.pin)}</div>
      </div>
      <div class="row-actions">
        <button class="iconbtn-sm" data-edit-socio="${s.id}" title="Editar">✎</button>
        <button class="iconbtn-sm" data-del-socio="${s.id}" title="Remover">✕</button>
      </div>
    </div>
  `).join("");
  wrap.querySelectorAll("[data-edit-socio]").forEach((b) => b.addEventListener("click", () => editSocio(b.dataset.editSocio)));
  wrap.querySelectorAll("[data-del-socio]").forEach((b) => b.addEventListener("click", () => deleteSocio(b.dataset.delSocio)));
}

function codeTaken(code, ignoreSocioId) {
  if (code === pins.operatorPin) return true;
  return socios.some((s) => s.pin === code && s.id !== ignoreSocioId);
}

$("add-socio-btn").addEventListener("click", async () => {
  const nome = $("new-socio-nome").value.trim();
  const pin = $("new-socio-pin").value.trim();
  if (!nome || !pin) { toast("Preenche nome e código."); return; }
  if (codeTaken(pin)) { toast("Esse código já está em uso."); return; }
  await addDoc(collection(fdb, "socios"), { nome, pin, createdAt: Date.now() });
  $("new-socio-nome").value = ""; $("new-socio-pin").value = "";
  toast("Sócio adicionado.");
});

function editSocio(id) {
  const s = socios.find((x) => x.id === id);
  if (!s) return;
  openModal(`
    <h3>Editar sócio</h3>
    <div class="field">
      <label>Nome</label>
      <input id="edit-socio-nome" value="${escapeHtml(s.nome)}">
    </div>
    <div class="field">
      <label>Código</label>
      <input id="edit-socio-pin" inputmode="numeric" value="${escapeHtml(s.pin)}">
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="cancel-edit-socio">Cancelar</button>
      <button class="btn btn-primary" id="confirm-edit-socio">Salvar</button>
    </div>
  `);
  $("cancel-edit-socio").addEventListener("click", closeModal);
  $("confirm-edit-socio").addEventListener("click", async () => {
    const nome = $("edit-socio-nome").value.trim();
    const pin = $("edit-socio-pin").value.trim();
    if (!nome || !pin) { toast("Preenche nome e código."); return; }
    if (codeTaken(pin, id)) { toast("Esse código já está em uso."); return; }
    await updateDoc(doc(fdb, "socios", id), { nome, pin });
    closeModal(); toast("Sócio atualizado.");
  });
}

function deleteSocio(id) {
  if (socios.length <= 1) { toast("Precisa deixar pelo menos um sócio cadastrado."); return; }
  const s = socios.find((x) => x.id === id);
  openModal(`
    <h3>Remover ${escapeHtml(s ? s.nome : "sócio")}?</h3>
    <p style="color:var(--text-dim); font-size:14px;">Essa pessoa não vai mais conseguir entrar como ADM com esse código.</p>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="cancel-del-socio">Cancelar</button>
      <button class="btn btn-danger" id="confirm-del-socio">Remover</button>
    </div>
  `);
  $("cancel-del-socio").addEventListener("click", closeModal);
  $("confirm-del-socio").addEventListener("click", async () => {
    await deleteDoc(doc(fdb, "socios", id));
    closeModal(); toast("Sócio removido.");
  });
}

// ---------------- ADMIN: operator pin ----------------
$("save-operator-pin-btn").addEventListener("click", async () => {
  const o = $("cfg-operator-pin").value.trim();
  if (!o) { toast("Preenche o código."); return; }
  if (codeTaken(o)) { toast("Esse código já está em uso por um sócio."); return; }
  await setDoc(doc(fdb, "config", "pins"), { operatorPin: o });
  toast("Código do operador atualizado.");
});
