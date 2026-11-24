"use strict";

const privateHistory = (() => {
  const repo = "https://api.github.com/repos/MK-RAFAEL/innosystem-historial-privado";
  const file = repo + "/contents/historial.json";
  const sessionKey = "innosystem-private-history-session";
  let token = "";
  try { token = sessionStorage.getItem(sessionKey) || ""; } catch {}

  async function request(url, options = {}) {
    try {
      return await fetch(url, {
        ...options, redirect: "error", cache: "no-store", credentials: "omit",
        signal: AbortSignal.timeout(25000),
        headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + token,
          ...options.headers },
      });
    } catch {
      throw new Error("No se pudo contactar con GitHub. Revisa la conexión y vuelve a intentarlo.");
    }
  }

  function requireSuccess(response) {
    if (response.ok) return;
    if ([401, 403, 404].includes(response.status)) {
      throw new Error("Comprueba que la clave esté vigente y tenga permiso de lectura y escritura en el repositorio privado.");
    }
    throw new Error("GitHub no pudo completar la sincronización (" + response.status + "). Inténtalo de nuevo.");
  }

  function encode(data) {
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
  }

  async function read() {
    const response = await request(file + "?ref=main");
    if (response.status === 404) return null;
    requireSuccess(response);
    const item = await response.json();
    let raw;
    if (item.encoding === "base64") {
      raw = new TextDecoder().decode(Uint8Array.from(atob(item.content), c => c.charCodeAt(0)));
    } else {
      const blob = await request(repo + "/git/blobs/" + item.sha, { headers: { Accept: "application/vnd.github.raw+json" } });
      requireSuccess(blob);
      raw = await blob.text();
    }
    const data = JSON.parse(raw);
    if (data.format !== 1 || !Array.isArray(data.docs) || !Number.isSafeInteger(data.nextQuote) ||
        !Number.isSafeInteger(data.nextInvoice) || !data.docs.every(doc => doc.id && doc.number && Array.isArray(doc.items))) {
      throw new Error("El historial privado tiene un formato desconocido. Se conservó la copia local.");
    }
    return { sha: item.sha, data };
  }

  async function transact(local, change) {
    const response = await request(repo);
    requireSuccess(response);
    const repository = await response.json();
    if (repository.private !== true || repository.id !== 1469529542) {
      throw new Error("Para guardar documentos, el repositorio del historial debe ser privado.");
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const remote = await read();
      if (!remote && local.paired) throw new Error("No se encontró el historial privado. Se conservó la copia de este dispositivo.");
      const data = remote?.data ?? { format: 1, company: {}, docs: [], nextQuote: 1, nextInvoice: 1 };
      const ids = new Set(data.docs.map(doc => doc.id));
      // Import documents unique to this device, even when different devices used the same printed number.
      const additions = local.docs.filter(doc => !ids.has(doc.id));
      data.docs.push(...additions);
      data.nextQuote = Math.max(data.nextQuote, local.nextQuote);
      data.nextInvoice = Math.max(data.nextInvoice, local.nextInvoice);
      const importCompany = !Object.keys(data.company).length && Object.keys(local.company).length > 0;
      if (importCompany) data.company = local.company;
      const result = change?.(data);
      if (change || !remote || additions.length || importCompany) {
        const update = await request(file, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "Guardar historial de InnoSystem", branch: "main",
            content: encode(data), ...(remote ? { sha: remote.sha } : {}) }),
        });
        if (update.status === 409 || (update.status === 422 && !remote)) continue;
        requireSuccess(update);
      }
      return { database: { ...data, paired: true }, result };
    }
    throw new Error("El historial cambió mientras guardabas. Tu borrador sigue disponible. Pulsa Guardar para reintentar.");
  }
  return {
    transact,
    get connected() { return Boolean(token); },
    setToken(value, remember = false) {
      token = value;
      try {
        if (remember && token) sessionStorage.setItem(sessionKey, token);
        else sessionStorage.removeItem(sessionKey);
      } catch {}
    },
  };
})();
