"use strict";

async function makeCustomerPdf(paper, doc) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const pdf = await PDFDocument.create();
  const heading = titleFor(doc.kind) + " " + doc.number;
  pdf.setTitle(heading);
  pdf.setAuthor("InnoSystem Multiservice");
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(.13, .12, .20), purple = rgb(.31, .16, .58);
  const pale = rgb(.96, .95, .98), rule = rgb(.86, .84, .90);
  const white = rgb(1, 1, 1);
  const left = 38, right = 574, bottom = 54;
  const canvas = document.createElement("canvas");
  const source = paper.querySelector(".doc-brand img");
  await source.decode();
  canvas.width = source.naturalWidth;
  canvas.height = source.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.filter = "brightness(1.25) contrast(1.05)";
  ctx.drawImage(source, 0, 0);
  const logo = await pdf.embedJpg(canvas.toDataURL("image/jpeg", .96));
  let page, y;
  const glyphs = new Set(regular.getCharacterSet());
  const fallback = (s) => Array.from(s).some((c) => !glyphs.has(c.codePointAt(0)));
  const pending = [];

  function width(s, size, font) {
    if (!fallback(s)) return font.widthOfTextAtSize(s, size);
    ctx.font = (font === bold ? "bold " : "") + size + "px Arial";
    return ctx.measureText(s).width;
  }
  function text(s, x, baseline, size = 10, font = regular, color = ink) {
    if (!s) return;
    if (!fallback(s)) {
      page.drawText(s, { x, y: baseline, size, font, color });
      return;
    }
    // Keep characters outside the standard PDF font repertoire visible.
    const tile = document.createElement("canvas");
    tile.width = Math.ceil((width(s, size, font) + 2) * 3);
    tile.height = Math.ceil(size * 1.7 * 3);
    const brush = tile.getContext("2d");
    brush.scale(3, 3);
    brush.font = (font === bold ? "bold " : "") + size + "px Arial";
    brush.fillStyle = "rgb(" + [color.red, color.green, color.blue].map(n => Math.round(n * 255)).join(",") + ")";
    brush.fillText(s, 0, size * 1.2);
    const target = page;
    pending.push(pdf.embedPng(tile.toDataURL()).then(image => target.drawImage(image, {
      x, y: baseline + size * 1.2 - tile.height / 3, width: tile.width / 3, height: tile.height / 3,
    })));
  }
  function wrap(s, limit, size, font = regular) {
    const lines = [];
    for (const paragraph of s.split(/\r?\n/)) {
      let line = "";
      for (const word of paragraph.trim().split(/\s+/)) {
        const next = line ? line + " " + word : word;
        if (width(next, size, font) <= limit) { line = next; continue; }
        if (line) lines.push(line);
        line = "";
        for (const ch of word) {
          if (line && width(line + ch, size, font) > limit) { lines.push(line); line = ""; }
          line += ch;
        }
      }
      lines.push(line);
    }
    return lines;
  }
  function alignRight(s, x, baseline, size, font = regular, color = ink) {
    text(s, x - width(s, size, font), baseline, size, font, color);
  }
  function separator(at, color = rule) {
    page.drawLine({ start: { x: left, y: at }, end: { x: right, y: at }, color, thickness: .8 });
  }
  function newPage() {
    page = pdf.addPage([612, 792]);
    page.drawImage(logo, { x: left, y: 714, width: 139, height: 139 * logo.height / logo.width });
    alignRight(titleFor(doc.kind), right, 741, 19, bold);
    alignRight(doc.number + "  |  " + displayDate(doc.date), right, 723, 10, regular, purple);
    separator(703, purple);
    y = 684;
  }
  function ensure(height) { if (y - height < bottom) newPage(); }
  newPage();
  const company = Array.from(paper.querySelectorAll(".doc-brand p"), p => p.textContent);
  for (const line of wrap(company.join("   ·   "), right - left, 9).filter(Boolean)) {
    text(line, left, y, 9); y -= 13;
  }
  const details = Array.from(paper.querySelectorAll(".doc-info section"));
  const blocks = details.map(section => Array.from(section.querySelectorAll("p"))
    .flatMap(p => wrap(p.textContent, 244, 10)));
  const count = Math.max(...blocks.map(lines => lines.length));
  const boxHeight = 34 + count * 13;
  page.drawRectangle({ x: left, y: y - boxHeight, width: right - left, height: boxHeight, color: pale });
  blocks.forEach((lines, i) => {
    const x = left + 12 + i * 268;
    text(details[i].querySelector("h3").textContent.toUpperCase(), x, y - 16, 9, bold, purple);
    lines.forEach((line, n) => text(line, x, y - 33 - n * 13));
  });
  y -= boxHeight + 16;
  const headers = Array.from(paper.querySelectorAll(".doc-table th"));
  const widths = headers.map(th => (right - left) * parseFloat(th.style.width) / 100);
  function tableHeader() {
    page.drawRectangle({ x: left, y: y - 22, width: right - left, height: 22, color: ink });
    let x = left;
    headers.forEach((th, i) => {
      const label = th.textContent;
      if (i < 2) text(label, x + 5, y - 14, 8, bold, white);
      else alignRight(label, x + widths[i] - 5, y - 14, 8, bold, white);
      x += widths[i];
    });
    y -= 22;
  }
  tableHeader();
  for (const row of paper.querySelectorAll("tbody tr")) {
    const cells = Array.from(row.cells, (cell, i) => wrap(cell.textContent, widths[i] - 10, 9));
    const height = Math.max(...cells.map(lines => lines.length)) * 12 + 12;
    if (y - height < bottom) { newPage(); tableHeader(); }
    let x = left;
    cells.forEach((lines, i) => {
      lines.forEach((line, n) => {
        const baseline = y - 14 - n * 12;
        if (i < 2) text(line, x + 5, baseline, 9);
        else alignRight(line, x + widths[i] - 5, baseline, 9);
      });
      x += widths[i];
    });
    y -= height;
    separator(y);
  }
  ensure(38 + 18 * paper.querySelector(".doc-summary").children.length);
  y -= 19;
  for (const row of paper.querySelector(".doc-summary").children) {
    const total = row.classList.contains("doc-total");
    if (total) page.drawRectangle({ x: right - 231, y: y - 7, width: 231, height: 23, color: pale });
    const size = total ? 12 : 10, font = total ? bold : regular;
    text(row.firstElementChild.textContent, right - 222, y, size, font);
    alignRight(row.lastElementChild.textContent, right - 8, y, size, font);
    y -= total ? 26 : 18;
  }
  for (const section of paper.querySelectorAll(".doc-note")) {
    const lines = wrap(section.querySelector("p").textContent, right - left, 10);
    ensure(35 + Math.min(lines.length, section.classList.contains("warranty") ? lines.length : 2) * 14);
    separator(y); y -= 18;
    text(section.querySelector("h3").textContent, left, y, 11, bold, purple); y -= 16;
    for (const line of lines) { ensure(14); text(line, left, y); y -= 14; }
    y -= 10;
  }
  const pages = pdf.getPages();
  pages.forEach((sheet, index) => {
    page = sheet;
    separator(41);
    text(paper.querySelector(".doc-footer").textContent, left, 27, 8);
    alignRight(doc.number + "   ·   " + (index + 1) + " / " + pages.length, right, 27, 8);
  });
  await Promise.all(pending);
  return pdf.save();
}
