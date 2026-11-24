"use strict";

// The browser remembers the directory handle; the records themselves live on disk.
const diskHistory = (() => {
  const primary = "historial.json";
  const previous = "historial-anterior.json";
  const folderName = "Historial InnoSystem";
  const permission = { mode: "readwrite" };
  let directory = null;
  let authorized = false;
  const pendingDrafts = new Map();
  let draftQueue = Promise.resolve();

  async function registry(writeHandle) {
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open("innosystem-carpeta", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("ubicacion");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("ubicacion", writeHandle ? "readwrite" : "readonly");
        const store = tx.objectStore("ubicacion");
        const request = writeHandle ? store.put(writeHandle, "pc") : store.get("pc");
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }

  const ready = registry().then(async handle => {
    directory = handle || null;
    authorized = Boolean(handle && await handle.queryPermission(permission) === "granted");
  }).catch(() => {});

  async function connect(chooseAnother = false) {
    if (!chooseAnother && directory && await directory.requestPermission(permission) === "granted") {
      authorized = true;
      return;
    }
    const selected = await window.showDirectoryPicker({ ...permission, id: "innosystem-historial", startIn: "desktop" });
    const folder = selected.name === folderName ? selected : await selected.getDirectoryHandle(folderName, { create: true });
    directory = folder;
    authorized = true;
    await registry(folder);
  }

  function checked(data) {
    if (!data || !Array.isArray(data.docs) || !data.company || typeof data.company !== "object" ||
        !Number.isSafeInteger(data.nextQuote) || !Number.isSafeInteger(data.nextInvoice) ||
        !data.docs.every(doc => doc && typeof doc.id === "string" && typeof doc.client === "string" &&
          ["quote", "invoice"].includes(doc.kind) && typeof doc.number === "string" &&
          typeof doc.date === "string" && doc.company && Array.isArray(doc.items) &&
          doc.items.every(item => item && typeof item.ref === "string" && typeof item.description === "string"))) {
      throw new Error("El archivo no contiene un historial válido de InnoSystem.");
    }
    return data;
  }

  async function readFile(name) {
    let handle;
    try { handle = await directory.getFileHandle(name); }
    catch (error) { if (error.name === "NotFoundError") return null; throw error; }
    const raw = await (await handle.getFile()).text();
    return checked(JSON.parse(raw.replace(/^\uFEFF/, "")));
  }

  async function writeFile(name, data) {
    const handle = await directory.getFileHandle(name, { create: true });
    const stream = await handle.createWritable();
    try {
      await stream.write(JSON.stringify(data));
      await stream.close();
    } catch (error) { await stream.abort().catch(() => {}); throw error; }
  }

  function merge(target, source, importing = false) {
    const known = new Map(target.docs.map(doc => [doc.id, doc]));
    for (const doc of source.docs) {
      const existing = known.get(doc.id);
      if (!existing) { target.docs.push(doc); known.set(doc.id, doc); }
      else if (doc.revision > existing.revision) {
        target.docs[target.docs.indexOf(existing)] = doc;
        known.set(doc.id, doc);
      } else if (importing && doc.revision === existing.revision && JSON.stringify(doc) !== JSON.stringify(existing)) {
        throw new Error("La copia tiene cambios distintos en " + doc.number + ". No se modificó el historial.");
      }
    }
    if (!Object.keys(target.company).length) target.company = source.company;
    target.nextQuote = Math.max(target.nextQuote, source.nextQuote);
    target.nextInvoice = Math.max(target.nextInvoice, source.nextInvoice);
  }

  async function transact(cache, change) {
    if (!directory || await directory.queryPermission(permission) !== "granted") {
      authorized = false;
      throw new Error("Pulsa «Guardar en mi PC» para dar acceso a la carpeta de tu historial.");
    }
    // Hold an exclusive lock while reading and replacing the snapshot, including across origins.
    const guard = await directory.getFileHandle("control.lock", { create: true });
    const lock = await guard.createWritable({ mode: "exclusive" });
    try {
      let original;
      try { original = await readFile(primary); }
      catch (error) {
        if (error instanceof DOMException) throw error;
        if (!await readFile(previous)) throw new Error("No se pudo leer el historial. Los archivos se conservaron.");
      }
      const fallback = original ? null : await readFile(previous);
      const data = structuredClone(original || fallback || { format: 1, docs: [], company: {}, nextQuote: 1, nextInvoice: 1 });
      const before = original && JSON.stringify(original);
      merge(data, cache);
      const result = change?.(data);
      if (before !== JSON.stringify(data)) {
        if (original) await writeFile(previous, original);
        await writeFile(primary, data);
        if (!original && !fallback) await writeFile(previous, data);
      }
      return { database: data, result };
    } finally { await lock.abort(); }
  }

  function draftFile(key) {
    const id = key.replace(/^innosystem-draft:/, "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Identificador de borrador inválido.");
    return id + ".json";
  }

  function queueDraft(key, raw, remove = false) {
    if (!authorized) return Promise.resolve();
    const folder = directory;
    const job = { raw, remove };
    pendingDrafts.set(key, job);
    const run = async () => {
      if (pendingDrafts.get(key) !== job) return;
      try {
        const drafts = await folder.getDirectoryHandle("borradores", { create: true });
        const name = draftFile(key);
        if (remove) {
          try {
            const handle = await drafts.getFileHandle(name);
            if (await (await handle.getFile()).text() === raw) await drafts.removeEntry(name);
          } catch (error) { if (error.name !== "NotFoundError") throw error; }
        } else {
          const handle = await drafts.getFileHandle(name, { create: true });
          const stream = await handle.createWritable();
          try { await stream.write(raw); await stream.close(); }
          catch (error) { await stream.abort().catch(() => {}); throw error; }
        }
      } finally {
        if (pendingDrafts.get(key) === job) pendingDrafts.delete(key);
      }
    };
    const operation = draftQueue.then(run);
    draftQueue = operation.catch(() => {});
    return operation;
  }

  async function recoverDrafts() {
    const folder = await directory.getDirectoryHandle("borradores", { create: true });
    for await (const [name, handle] of folder.entries()) {
      if (handle.kind !== "file" || !/^[0-9a-f-]{36}\.json$/i.test(name)) continue;
      const key = "innosystem-draft:" + name.slice(0, -5);
      if (localStorage.getItem(key) !== null) continue;
      let raw;
      try { raw = await (await handle.getFile()).text(); }
      catch (error) { if (error.name === "NotFoundError") continue; throw error; }
      if (!raw) continue;
      const doc = JSON.parse(raw);
      if (["quote", "invoice"].includes(doc.kind) && Array.isArray(doc.items)) localStorage.setItem(key, raw);
    }
  }
  return { ready, connect, transact, checked, merge, queueDraft, recoverDrafts,
    get active() { return authorized; }, get configured() { return Boolean(directory); },
    get supported() { return typeof window.showDirectoryPicker === "function"; } };
})();
