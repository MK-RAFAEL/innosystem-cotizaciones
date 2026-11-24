"use strict";

const $ = (selector) => document.querySelector(selector);
const form = $("#document-form");
const storageKey = "innosystem-documents-v1";
const clientFields = ["client", "rnc", "phone", "attention", "recipient", "street", "sector", "municipality", "city"];
const documentFields = [...clientFields, "date", "seller", "payment", "delivery", "warranty", "tax", "notes"];
const companyFields = ["rnc", "phone", "email", "address"];
const columns = ["Ref.", "Descripción", "Cant.", "Precio", "% Desc.", "ITBIS", "Subtotal"];
const amounts = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const quantities = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const icons = (name) => '<svg class="icon" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
const escaped = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[c]);
const money = (cents) => amounts.format(cents / 100);
const pesos = (cents) => "RD$ " + money(cents);
const titleFor = (kind) => kind === "quote" ? "Cotización" : "Factura final";
const viewFor = (kind) => kind === "quote" ? "quotes" : "invoices";
const displayDate = (date) => date ? date.split("-").reverse().join("/") : "—";

function today() {
  const date = new Date();
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part) => String(part).padStart(2, "0")).join("-");
}

function readDatabase() {
  const raw = localStorage.getItem(storageKey);
  const db = raw ? JSON.parse(raw) : { company: {}, docs: [], nextQuote: 1, nextInvoice: 1 };
  if (db.docs.some(doc => !doc.id)) {
    const key = "innosystem-legacy-device";
    const device = localStorage.getItem(key) || crypto.randomUUID();
    localStorage.setItem(key, device);
    for (const doc of db.docs) {
      doc.id ||= device + "-" + doc.number;
      if (doc.quoteNumber) doc.quoteId ||= device + "-" + doc.quoteNumber;
    }
  }
  return db;
}

let database;
let startupError = false;
try {
  database = readDatabase();
} catch {
  database = { company: {}, docs: [], nextQuote: 1, nextInvoice: 1 };
  startupError = true;
}

let transactionQueue = Promise.resolve();
function transact(change) {
  const write = async () => {
    const fresh = readDatabase();
    if (fresh.paired && !privateHistory.connected) throw new Error("Conecta tu historial privado para guardar. Tu borrador se conserva en este dispositivo.");
    let next = fresh, result;
    if (privateHistory.connected) {
      const synced = await privateHistory.transact(fresh, change);
      next = synced.database;
      result = synced.result;
    } else result = change?.(fresh);
    localStorage.setItem(storageKey, JSON.stringify(next));
    database = next;
    return result;
  };
  const run = () => navigator.locks ? navigator.locks.request(storageKey, write) : write();
  const operation = transactionQueue.then(run);
  transactionQueue = operation.catch(() => {});
  return operation;
}

const newItem = () => ({ ref: "", description: "", qty: "1", price: "0", discount: "0", rate: "18" });
function newQuote() {
  return {
    ...Object.fromEntries(documentFields.map((key) => [key, ""])),
    kind: "quote", date: today(), tax: "none", warranty: "30",
    company: { ...database.company }, items: [newItem()],
  };
}

let current = newQuote();
let dirty = false;
let busy = false;
let listView = "quotes";
let toastTimeout;
const draftPrefix = "innosystem-draft:";
let draftKey = draftPrefix + crypto.randomUUID();
let draftSafe = false;
let lastDraft = null;

function keepDraft() {
  try {
    if (localStorage.getItem(draftKey) !== lastDraft) draftKey = draftPrefix + crypto.randomUUID();
    const raw = JSON.stringify(current);
    localStorage.setItem(draftKey, raw);
    lastDraft = raw;
    draftSafe = true;
  } catch {
    draftSafe = false;
    notify("El navegador no pudo conservar este borrador. Mantén la página abierta.", true);
  }
}

function drafts() {
  try {
    return Object.keys(localStorage).filter(key => key.startsWith(draftPrefix))
      .map(key => ({ key, doc: JSON.parse(localStorage.getItem(key)) })).filter(entry => entry.doc);
  } catch { return []; }
}

function notify(message, error = false) {
  const toast = $("#toast");
  clearTimeout(toastTimeout);
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.hidden = false;
  toastTimeout = setTimeout(() => { toast.hidden = true; }, error ? 8000 : 4200);
}

function roundRatio(value, divisor) {
  return (value + divisor / 2n) / divisor;
}

function calculate(item, tax) {
  const hundredths = (value, max) => BigInt(Math.round(Math.min(max, Math.max(0, Number(value) || 0)) * 100));
  const gross = roundRatio(hundredths(item.qty, 9999.99) * hundredths(item.price, 9999999.99), 100n);
  const discountRate = hundredths(item.discount, 100);
  const rate = tax === "none" ? 0n : hundredths(item.rate, 100);
  const rawDiscount = roundRatio(gross * discountRate, 10000n);
  const discounted = gross - rawDiscount;
  if (tax === "included") {
    const baseGross = roundRatio(gross * 10000n, 10000n + rate);
    const base = roundRatio(discounted * 10000n, 10000n + rate);
    return { gross: Number(baseGross), discount: Number(baseGross - base), tax: Number(discounted - base), base: Number(base), total: Number(discounted) };
  }
  const itbis = roundRatio(discounted * rate, 10000n);
  return { gross: Number(gross), discount: Number(rawDiscount), tax: Number(itbis), base: Number(discounted), total: Number(discounted + itbis) };
}

function numericInput(name, label, value, min, max) {
  return '<label>' + label + '<input type="number" inputmode="decimal" data-field="' + name +
    '" value="' + escaped(value) + '" min="' + min + '" max="' + max + '" step="0.01" required></label>';
}

function renderItems() {
  $("#items").innerHTML = current.items.map((item, i) => `
    <div class="item" data-index="${i}">
      <div class="item-heading">
        <strong>Partida ${i + 1}</strong><output aria-label="Total de la partida"></output>
        <button type="button" class="icon-button" data-remove aria-label="Eliminar partida ${i + 1}">${icons("trash")}</button>
      </div>
      <div class="item-top">
        <label>Referencia<input data-field="ref" placeholder="Código" maxlength="40" value="${escaped(item.ref)}"></label>
        <label>Descripción (opcional)<input data-field="description" placeholder="Ej. Instalación de cámaras" maxlength="380" value="${escaped(item.description)}"></label>
      </div>
      <div class="item-values">
        ${numericInput("qty", "Cantidad", item.qty, "0.01", "9999.99")}
        ${numericInput("price", "Precio unitario (RD$)", item.price, "0", "9999999.99")}
        ${numericInput("discount", "Descuento (%)", item.discount, "0", "100")}
        <div class="item-rate" ${current.tax === "none" ? "hidden" : ""}>${numericInput("rate", "ITBIS (%)", item.rate, "0", "100")}</div>
      </div>
    </div>`).join("");
  updateItemTax();
}

function updateItemTax() {
  document.querySelectorAll(".item-rate").forEach((wrapper) => {
    wrapper.hidden = current.tax === "none";
    wrapper.firstElementChild.firstElementChild.disabled = wrapper.hidden;
  });
}

function detail(label, value) {
  return value ? '<p><strong>' + label + ':</strong> ' + escaped(value) + '</p>' : "";
}

function warrantyText(days) {
  return 'Los trabajos de instalación cuentan con una garantía de <strong>' + escaped(days) +
    ' días calendario</strong> a partir de la fecha de emisión de esta factura, cubriendo exclusivamente defectos de mano de obra. ' +
    'Los equipos y materiales suministrados se rigen por la garantía directa del fabricante. ' +
    'Esta garantía queda anulada en caso de manipulación por terceros, mal uso, sobrecargas eléctricas, humedad o daños accidentales. ' +
    'Para reclamos, es indispensable presentar esta factura.';
}

function summarize(lines) {
  return lines.reduce((sum, line) => ({
    gross: sum.gross + line.gross, discount: sum.discount + line.discount,
    tax: sum.tax + line.tax, total: sum.total + line.total,
  }), { gross: 0, discount: 0, tax: 0, total: 0 });
}

function documentHtml(doc) {
  const invoice = doc.kind === "invoice";
  const items = doc.items.filter(hasItemData);
  const lines = items.map((item) => calculate(item, doc.tax));
  const sum = summarize(lines);
  const company = doc.company;
  const address = [doc.street, doc.sector, doc.municipality, doc.city].filter(Boolean).join(", ");
  const contact = [company.phone, company.email, company.address].filter(Boolean).join(" · ");
  const rows = items.map((item, index) => {
    const line = lines[index];
    const cells = [
      item.ref || "—", item.description || "—", quantities.format(Number(item.qty) || 0),
      money(Number(item.price) * 100 || 0), quantities.format(Number(item.discount) || 0) + "%",
      money(line.tax), money(line.base),
    ];
    return "<tr>" + cells.map((cell, i) => '<td data-label="' + columns[i] + '">' + escaped(cell) + "</td>").join("") + "</tr>";
  }).join("");
  return `
    <header class="doc-header">
      <div class="doc-brand">
        <img src="data:image/jpeg;base64,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" alt="InnoSystem Multiservice" width="183" height="62">
        ${detail("RNC", company.rnc)}
        ${contact ? "<p>" + escaped(contact) + "</p>" : ""}
      </div>
      <div class="doc-ident"><h2>${titleFor(doc.kind)}</h2><span class="doc-number">${escaped(doc.number || "Borrador")}</span><p>${displayDate(escaped(doc.date))}</p></div>
    </header>
    <div class="doc-info">
      <section><h3>Cliente</h3><p class="${doc.client ? "" : "faint"}"><strong>${escaped(doc.client || "Nombre del cliente")}</strong></p>
        ${detail("RNC o cédula", doc.rnc)}${detail("Atención", doc.attention)}${detail("Teléfono", doc.phone)}
        ${detail("Dirección", address)}${detail("Enviar a", doc.recipient)}
      </section>
      <section><h3>${invoice ? "Facturación" : "Condiciones"}</h3>
        ${detail("Vendedor", doc.seller)}
        ${detail("Pago", doc.payment)}${invoice ? detail("Cotización", doc.quoteNumber) : detail("Entrega", doc.delivery)}
        ${!doc.seller && !doc.payment && !(invoice ? doc.quoteNumber : doc.delivery) ? '<p class="faint">—</p>' : ""}
      </section>
    </div>
    <table class="doc-table" aria-label="Partidas en pesos dominicanos">
      <thead><tr>${columns.map((column) => '<th scope="col">' + column + '</th>').join("")}</tr></thead>
      <tbody>${rows || '<tr><td class="faint empty-row" colspan="7">Las partidas aparecerán aquí.</td></tr>'}</tbody>
    </table>
    <div class="doc-summary">
      <div><span>Subtotal</span><span>${pesos(sum.gross)}</span></div>
      <div><span>Descuento</span><span>${pesos(sum.discount)}</span></div>
      <div><span>ITBIS</span><span>${pesos(sum.tax)}</span></div>
      <div class="doc-total"><span>Total</span><span>${pesos(sum.total)}</span></div>
    </div>
    ${doc.notes ? '<section class="doc-note"><h3>Observaciones</h3><p>' + escaped(doc.notes) + "</p></section>" : ""}
    ${invoice ? '<section class="doc-note warranty"><h3>Términos de garantía</h3><p>' + warrantyText(doc.warranty) + "</p></section>" : ""}
    <footer class="doc-footer">${invoice ? "Documento comercial sin NCF" : "InnoSystem Multiservice"}</footer>`;
}

function renderPreview() {
  $("#paper").innerHTML = documentHtml(current);
  current.items.forEach((item, i) => {
    $("#items").children[i].querySelector("output").textContent = pesos(calculate(item, current.tax).total);
  });
}

function linkedInvoice() {
  return current.id && database.docs.find((doc) => doc.quoteId === current.id);
}

function renderHeading() {
  const invoice = current.kind === "invoice";
  const title = current.number ? titleFor(current.kind) + " " + current.number : invoice ? "Nueva factura" : "Nueva cotización";
  $("#page-title").textContent = title;
  $("#breadcrumb").textContent = title;
  $("#page-description").textContent = invoice
    ? "Generada a partir de la cotización " + current.quoteNumber + "."
    : "Registra el cliente y los servicios de instalación.";
  const status = $("#status");
  status.textContent = dirty && draftSafe ? "Borrador guardado en este dispositivo" : current.number ? (dirty ? "Cambios sin guardar" : "Guardada") : "Borrador";
  status.classList.toggle("saved", Boolean(current.number && !dirty));
  $("#conversion-bar").hidden = invoice || !current.number;
  $("#convert span").textContent = linkedInvoice() ? "Abrir factura asociada" : "Crear factura desde esta cotización";
}

function highlightNav(view) {
  document.querySelectorAll("[data-view]").forEach((button) => {
    if (view === button.dataset.view) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
}

function showEditor() {
  $("#editor").hidden = false;
  $("#history").hidden = true;
  highlightNav(viewFor(current.kind));
  renderHeading();
}

function loadEditor(doc, resumeKey = null) {
  draftKey = resumeKey || draftPrefix + crypto.randomUUID();
  lastDraft = resumeKey ? localStorage.getItem(resumeKey) : null;
  draftSafe = Boolean(resumeKey);
  current = structuredClone(doc);
  dirty = Boolean(resumeKey);
  for (const key of documentFields) {
    form.elements[key].value = current[key];
    form.elements[key].setCustomValidity("");
  }
  form.querySelector(".address").open = Boolean(current.street || current.sector || current.municipality || current.city);
  $("#warranty-label").hidden = current.kind !== "invoice";
  $("#delivery-label").hidden = current.kind === "invoice";
  renderItems();
  showEditor();
  renderPreview();
  window.scrollTo(0, 0);
}

function renderHistory() {
  const query = $("#search").value.trim().toLocaleLowerCase("es");
  const pending = drafts().filter(({ doc }) => viewFor(doc.kind) === listView &&
    ((doc.client || "").toLowerCase().includes(query) || (doc.number || "").toLowerCase().includes(query)));
  $("#draft-list").innerHTML = pending.length ? "<h2>Borradores de este dispositivo</h2>" + pending.map(({ key, doc }) =>
    '<div class="history-row"><strong>' + escaped(doc.number || "Borrador") + '</strong><div>' + escaped(doc.client || "Sin nombre de cliente") +
    '</div><span></span><button class="button button-secondary" data-draft="' + escaped(key) + '">Continuar</button></div>').join("") : "";
  const docs = database.docs.filter((doc) => viewFor(doc.kind) === listView &&
    (doc.client.toLocaleLowerCase("es").includes(query) || doc.number.toLowerCase().includes(query)));
  $("#history-list").innerHTML = docs.length ? docs.map((doc) => {
    const amount = summarize(doc.items.map((item) => calculate(item, doc.tax))).total;
    return `<div class="history-row">
      <div><strong>${escaped(doc.number)}</strong><p>${displayDate(escaped(doc.date))}</p></div>
      <div>${escaped(doc.client)}${doc.quoteNumber ? "<p>Cotización " + escaped(doc.quoteNumber) + "</p>" : ""}</div>
      <strong>${pesos(amount)}</strong>
      <div class="history-actions"><button class="button button-secondary" type="button" data-open="${escaped(doc.id)}">Abrir</button>
      ${doc.kind === "quote" ? '<button class="button button-secondary" type="button" data-invoice="' + escaped(doc.id) + '">' +
        (database.docs.some(saved => saved.quoteId === doc.id) ? "Ver factura" : "Crear factura") + "</button>" : ""}</div>
    </div>`;
  }).join("") : '<p class="empty-history">' + (query ? "No se encontraron documentos." :
    listView === "quotes" ? "Todavía no hay cotizaciones guardadas." : "Todavía no hay facturas guardadas.") + "</p>";
}

function showHistory(view) {
  listView = view;
  const title = view === "quotes" ? "Cotizaciones" : "Facturas";
  $("#history-title").textContent = title;
  $("#breadcrumb").textContent = title;
  $("#search").value = "";
  $("#editor").hidden = true;
  $("#history").hidden = false;
  highlightNav(view);
  renderHistory();
  refreshHistory();
  window.scrollTo(0, 0);
}

async function canReplaceEditor() {
  if (busy) return false;
  if (!dirty || draftSafe) return true;
  const dialog = $("#discard-dialog");
  if (dialog.open) return false;
  dialog.returnValue = "cancel";
  dialog.showModal();
  await new Promise((resolve) => dialog.addEventListener("close", resolve, { once: true }));
  return dialog.returnValue === "discard";
}

function hasItemData(item) {
  return Boolean(item.ref.trim() || item.description.trim() || Number(item.price) > 0);
}

function validate() {
  const client = form.elements.client;
  client.setCustomValidity(client.value.trim() ? "" : "Escribe el nombre del cliente.");
  if (!current.items.some(hasItemData)) {
    const price = form.querySelector('[data-field="price"]');
    price.setCustomValidity("Agrega un precio, una referencia o una descripción a una partida.");
    price.reportValidity();
    price.setCustomValidity("");
    return false;
  }
  return form.reportValidity();
}

async function saveDocument() {
  current.id ||= crypto.randomUUID();
  if (dirty) keepDraft();
  const snapshot = structuredClone(current);
  snapshot.items = snapshot.items.filter(hasItemData);
  for (const key of documentFields) snapshot[key] = snapshot[key].trim();
  for (const item of snapshot.items) {
    item.description = item.description.trim();
    item.ref = item.ref.trim();
  }
  const saved = await transact((fresh) => {
    const record = structuredClone(snapshot);
    if (!snapshot.number) {
      const prior = fresh.docs.find(doc => doc.id === snapshot.id);
      if (prior) {
        const { number, revision, ...previous } = prior;
        if (JSON.stringify(previous) === JSON.stringify(snapshot)) return prior;
        throw new Error("Este documento ya se guardó. Abre la versión guardada en el historial.");
      }
      const duplicate = snapshot.quoteId && fresh.docs.find((doc) => doc.quoteId === snapshot.quoteId);
      if (duplicate) throw new Error("Ya existe una factura para esta cotización. Ábrela desde el historial.");
      const quote = snapshot.kind === "quote";
      const counter = quote ? "nextQuote" : "nextInvoice";
      record.number = (quote ? "COT-" : "FAC-") + String(fresh[counter]++).padStart(4, "0");
    } else {
      const stored = fresh.docs.find((doc) => doc.id === snapshot.id);
      if (stored?.revision !== snapshot.revision) {
        throw new Error("Se guardó otra versión de este documento. Tu borrador sigue disponible. Abre la versión guardada desde el historial.");
      }
    }
    record.revision = (snapshot.revision || 0) + 1;
    fresh.docs = [record, ...fresh.docs.filter((doc) => doc.id !== record.id)];
    return record;
  });
  current = saved;
  if (lastDraft && localStorage.getItem(draftKey) === lastDraft) localStorage.removeItem(draftKey);
  lastDraft = null;
  draftSafe = false;
  renderItems();
  dirty = false;
  renderHeading();
  renderPreview();
  return saved;
}

function setBusy(value) {
  busy = value;
  form.inert = value;
  for (const id of ["save", "print", "convert", "new-quote"]) $("#" + id).disabled = value;
}

async function handleDocument(action) {
  if (busy || !validate()) return;
  setBusy(true);
  try {
    if (dirty || !current.number) await saveDocument();
    await action();
  } catch (error) {
    const message = error instanceof DOMException || error instanceof SyntaxError
      ? "No se pudo guardar. Revisa que el navegador permita el almacenamiento local."
      : error.message;
    notify(message, true);
  } finally {
    setBusy(false);
  }
}

function preparePrint() {
  const paper = $("#paper").cloneNode(true);
  paper.removeAttribute("id");
  $("#print-root").replaceChildren(paper);
}

form.addEventListener("input", (event) => {
  const field = event.target;
  if (field.willValidate) field.setCustomValidity("");
  if (field.dataset.field) {
    current.items[field.closest(".item").dataset.index][field.dataset.field] = field.value;
  } else if (documentFields.includes(field.name)) {
    current[field.name] = field.value;
    if (field.name === "tax") updateItemTax();
  }
  dirty = true;
  keepDraft();
  renderHeading();
  renderPreview();
});

function updateItems(focusIndex) {
  dirty = true;
  keepDraft();
  renderHeading();
  renderItems();
  renderPreview();
  $("#items").children[focusIndex]?.querySelector('[data-field="description"]').focus();
}

$("#add-item").onclick = () => {
  current.items.push(newItem());
  updateItems(current.items.length - 1);
};
$("#items").onclick = (event) => {
  const remove = event.target.closest("[data-remove]");
  if (!remove) return;
  const index = Number(remove.closest(".item").dataset.index);
  current.items.splice(index, 1);
  if (!current.items.length) current.items.push(newItem());
  updateItems(Math.min(index, current.items.length - 1));
};

form.addEventListener("submit", (event) => {
  event.preventDefault();
  handleDocument(() => notify(titleFor(current.kind) + " " + current.number + " guardada."));
});
window.addEventListener("beforeprint", preparePrint);
let pdfUrl;
$("#print").onclick = () => handleDocument(async () => {
  const bytes = await makeCustomerPdf($("#paper"), current);
  if (pdfUrl) URL.revokeObjectURL(pdfUrl);
  pdfUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  $("#pdf-download").href = $("#pdf-open").href = pdfUrl;
  $("#pdf-download").download = "InnoSystem-" + current.number + ".pdf";
  $("#pdf-dialog-title").textContent = titleFor(current.kind) + " " + current.number;
  $("#pdf-dialog").showModal();
});
$("#convert").onclick = () => handleDocument(() => {
  database = readDatabase();
  const linked = linkedInvoice();
  if (linked) {
    loadEditor(linked);
    return;
  }
  const pending = drafts().find(entry => entry.doc.kind === "invoice" && !entry.doc.number && entry.doc.quoteId === current.id);
  if (pending) {
    loadEditor(pending.doc, pending.key);
    notify("Abriste el borrador de factura de esta cotización.");
    return;
  }
  const { number, revision, id, ...source } = current;
  loadEditor({ ...source, kind: "invoice", quoteId: id, quoteNumber: number, date: today() });
  dirty = true;
  keepDraft();
  renderHeading();
  notify("Factura preparada. Selecciona la garantía y guarda el documento.");
});

$("#new-quote").onclick = async () => {
  if (await canReplaceEditor()) loadEditor(newQuote());
};
$("#brand").onclick = (event) => { event.preventDefault(); showEditor(); };
$("#return-editor").onclick = showEditor;
$("#history-button").onclick = () => showHistory(viewFor(current.kind));
document.querySelectorAll("[data-view]").forEach((button) => {
  button.onclick = () => showHistory(button.dataset.view);
});
$("#history-list").onclick = async (event) => {
  const button = event.target.closest("[data-open], [data-invoice]");
  if (!button || !(await canReplaceEditor())) return;
  const doc = database.docs.find((saved) => saved.id === (button.dataset.open || button.dataset.invoice));
  if (doc) {
    loadEditor(doc);
    if (button.dataset.invoice) $("#convert").click();
  }
};
$("#draft-list").onclick = async event => {
  const key = event.target.closest("[data-draft]")?.dataset.draft;
  if (!key || !(await canReplaceEditor())) return;
  const draft = drafts().find(entry => entry.key === key);
  if (draft) loadEditor(draft.doc, key);
};
$("#search").oninput = renderHistory;
$("#toggle-preview").onclick = (event) => {
  const frame = $("#paper-frame");
  const button = event.currentTarget;
  frame.hidden = !frame.hidden;
  button.setAttribute("aria-expanded", String(!frame.hidden));
  button.textContent = frame.hidden ? "Mostrar" : "Ocultar";
};
const desktopPreview = window.matchMedia("(min-width: 761px)");
desktopPreview.addEventListener("change", (event) => {
  if (event.matches && $("#paper-frame").hidden) $("#toggle-preview").click();
});

const companyForm = $("#company-form");
$("#settings").onclick = () => {
  for (const key of companyFields) companyForm.elements[key].value = database.company[key] || "";
  $("#company-dialog").showModal();
};
document.querySelectorAll("[data-close]").forEach((button) => {
  button.onclick = () => $("#" + button.dataset.close).close();
});
companyForm.onsubmit = async (event) => {
  event.preventDefault();
  const submit = companyForm.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const company = Object.fromEntries(companyFields.map((key) => [key, companyForm.elements[key].value.trim()]));
    await transact((fresh) => { fresh.company = company; });
    if (!current.number && !current.quoteNumber) {
      current.company = { ...company };
      renderPreview();
    }
    $("#company-dialog").close();
    notify("Datos de empresa guardados.");
  } catch {
    $("#company-dialog").close();
    notify("No se pudieron guardar los datos de empresa.", true);
  } finally {
    submit.disabled = false;
  }
};

window.addEventListener("storage", (event) => {
  if (event.key !== storageKey) return;
  database = readDatabase();
  if (!$("#history").hidden) renderHistory();
  else renderHeading();
});
window.addEventListener("beforeunload", (event) => {
  if (dirty && !draftSafe) event.preventDefault();
});

let refreshing = false;
let lastSyncError = "";
function updateAccount() {
  const connected = privateHistory.connected;
  $("#account").textContent = connected ? (lastSyncError ? "Revisar conexión" : "Historial privado") : "Conectar historial privado";
  $("#cloud-status").textContent = lastSyncError || (connected ? "Conectado a MK-RAFAEL." : "Conexión con tu cuenta de GitHub.");
  $("#account-connect").hidden = connected;
  $("#disconnect").hidden = !connected;
  $("#cloud-submit").textContent = connected ? "Actualizar historial" : "Conectar y sincronizar";
  $("#history-description").textContent = lastSyncError || (connected ? "Cotizaciones y facturas de tu cuenta privada." :
    database.paired ? "Copia de este dispositivo. Conecta tu cuenta para actualizarla." : "Documentos de este dispositivo. Conecta tu cuenta para sincronizarlos.");
}

async function refreshHistory() {
  if (refreshing || !privateHistory.connected || busy) return;
  refreshing = true;
  try {
    await transact();
    lastSyncError = "";
    if (!$("#history").hidden) renderHistory();
    else renderHeading();
  } catch (error) {
    lastSyncError = error.message;
  } finally {
    refreshing = false;
    updateAccount();
  }
}

$("#account").onclick = () => {
  updateAccount();
  $("#account-dialog").showModal();
};
$("#account-form").onsubmit = async event => {
  event.preventDefault();
  const input = $("#cloud-key");
  const connecting = !privateHistory.connected;
  if (connecting && !input.value.trim()) { input.focus(); return; }
  const key = input.value.trim();
  if (connecting && !key.startsWith("github_pat_")) {
    $("#cloud-status").textContent = "Usa una clave de acceso de permisos específicos (fine-grained).";
    return;
  }
  const submit = $("#cloud-submit");
  submit.disabled = true;
  $("#disconnect").disabled = true;
  $("#cloud-status").textContent = "Sincronizando el historial…";
  try {
    if (connecting) privateHistory.setToken(key);
    await transact();
    if (connecting) privateHistory.setToken(key, true);
    input.value = "";
    lastSyncError = "";
    if (!dirty && !current.number && !current.quoteId) current.company = { ...database.company };
    $("#account-dialog").close();
    showHistory("quotes");
    notify("Historial privado sincronizado.");
  } catch (error) {
    if (connecting) privateHistory.setToken("");
    lastSyncError = error.message;
  } finally {
    submit.disabled = false;
    $("#disconnect").disabled = false;
    updateAccount();
  }
};
$("#disconnect").onclick = () => {
  privateHistory.setToken("");
  lastSyncError = "";
  updateAccount();
  $("#account-dialog").close();
  notify("Sesión desconectada. Este navegador conserva su copia del historial.");
};
window.addEventListener("focus", refreshHistory);
window.addEventListener("online", refreshHistory);
setInterval(() => { if (document.visibilityState === "visible") refreshHistory(); }, 60000);
loadEditor(current);
updateAccount();
if (database.docs.length || drafts().length || privateHistory.connected) showHistory("quotes");
if (startupError) notify("No se pudo leer el historial de este navegador.", true);
