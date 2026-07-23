export function compact(text: string) {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .replace(/\u00ad/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([,.;:?])/g, "$1")
    .trim();
}

export function inferChapterLabel(name: string) {
  const ordinal = name.match(/\b(\d+)(?:st|nd|rd|th)\s+chapter\b/i);
  const standard = name.match(/\bchapter\s*[-_. ]*(\d+)\b/i);
  const number = ordinal?.[1] ?? standard?.[1];
  return number ? `Chapter ${Number(number)}` : "";
}

export function isPdfSectionHeading(text: string) {
  const value = compact(text);
  return (
    value.length >= 5 &&
    value.length <= 160 &&
    !/[?.!]$/.test(value) &&
    /^\d+(?:\.\d+)+(?:\s*[-–—]\s*\d+(?:\.\d+)*)?\s+[A-Z][A-Za-z0-9][^?]*$/.test(value)
  );
}

function stripPdfStructureArtifacts(text: string) {
  let value = compact(text);
  const sourceReference = value.search(/(?:^|\s)Source\s+(?:reference\s*:|PDF\s+page\b)/i);
  if (sourceReference >= 0) value = value.slice(0, sourceReference);

  const sectionSuffix = value.match(
    /(?:^|\s)(\d+(?:\.\d+)+(?:\s*[-–—]\s*\d+(?:\.\d+)*)?\s+[A-Z][A-Za-z0-9][^?.!]{1,140})$/,
  );
  if (sectionSuffix?.index !== undefined && sectionSuffix.index > 0 && isPdfSectionHeading(sectionSuffix[1])) {
    value = value.slice(0, sectionSuffix.index);
  }
  return compact(value);
}

export function stripKnownPageFurniture(text: string) {
  const withoutFurniture = compact(text)
    .replace(/\s*The\s+Contract\s+Act,?\s*1872\s*[—–-]+\s*Line[- ]by[- ]Line\s+MCQ\s+Bank(?:\s*\(ICAB\))?(?:\s*[—–-]+\s*Set\s*\d+)?(?:\s+\d+)?\s*$/i, "")
    .replace(/\s*ICAB\s+BUSINESS\s+LAW\s*\|\s*QUESTION\s+BANK(?:\s*[—–-]+\s*SET\s*\d+)?(?:\s+\d+)?\s*$/i, "")
    .replace(/\s*BR\s+PUBLICATION\s*\|.*$/i, "")
    .replace(/\s+(?:Page\s+)?\d+\s*\|\s*Page\s*$/i, "")
    .trim();
  return stripPdfStructureArtifacts(withoutFurniture);
}

export function stripEmbeddedAnswerSection(text: string) {
  const cleaned = stripKnownPageFurniture(text);
  const marker = cleaned.search(/<\s*(?:details|summary)\b|Answer\s*key\s*[—–:-]/i);
  const beforeMarker = marker >= 0 ? cleaned.slice(0, marker) : cleaned;
  const orphanedKeyTail = beforeMarker.search(
    /(?:^|\s)(?:[A-F]\s*,\s*)?\d+\s*[-–—:]\s*[A-F](?:\s*,\s*\d+\s*[-–—:]\s*[A-F]){1,}(?:\s*<\/?details\s*>)?\s*$/i,
  );
  const withoutKeyTail = orphanedKeyTail >= 0 ? beforeMarker.slice(0, orphanedKeyTail) : beforeMarker;
  return compact(withoutKeyTail.replace(/<\/?(?:details|summary)\s*>/gi, " "));
}

export function extractAnswerKeyMap(lines: string[]) {
  const answers = new Map<string, number[]>();
  const keyPattern = /\b(P\d+-Q\d+|\d+)\s*[-–—:]\s*([A-F](?:\s*[,/&+]\s*[A-F])*)/gi;
  const collect = (text: string) => {
    for (const match of text.matchAll(keyPattern)) {
      const indexes = [...new Set((match[2].toUpperCase().match(/[A-F]/g) ?? []).map((letter) => letter.charCodeAt(0) - 65))];
      if (indexes.length) answers.set(match[1].toUpperCase(), indexes);
    }
  };

  let inConsolidatedAnswerSection = false;
  for (const line of lines) {
    if (/Consolidated\s+answer\s+section/i.test(line)) inConsolidatedAnswerSection = true;
    if (inConsolidatedAnswerSection) {
      const tableRow = compact(line).match(/^(P\d+-Q\d+|\d+)\s+([A-F])[.)]\s+\S/i);
      if (tableRow) answers.set(tableRow[1].toUpperCase(), [tableRow[2].toUpperCase().charCodeAt(0) - 65]);
    }
    if (/answer|correct/i.test(line) || /^(?:P\d+-Q\d+|\d+)\s*[-–—:]\s*[A-F]/i.test(line)) collect(line);
  }

  const joined = lines.join(" ");
  const blocks = joined.matchAll(/Answer\s*key\s*[—–:-][\s\S]*?(?:(?:<\s*)?\/\s*details\s*>|$)/gi);
  for (const block of blocks) {
    const repairedSplits = block[0].replace(/\b(\d+)\s+([A-F])(?=\s*(?:,|<|\/\s*details))/gi, "$1-$2");
    collect(repairedSplits);
  }

  return answers;
}

export function isPageFurniture(line: string) {
  const value = compact(line);
  return (
    !value ||
    /^(?:Page\s+\d+|\d+\s*\|\s*Page)$/i.test(value) ||
    /^Source\s+(?:reference\s*:|PDF\s+page\b)/i.test(value) ||
    /^The\s+Contract\s+Act,?\s*1872\s*[—–-]+\s*Line[- ]by[- ]Line\s+MCQ\s+Bank/i.test(value) ||
    /^ICAB\s+BUSINESS\s+LAW\s*\|\s*QUESTION\s+BANK/i.test(value) ||
    /^BR\s+PUBLICATION\s*\|/i.test(value)
  );
}

function furnitureKey(line: string) {
  return compact(line)
    .replace(/\bPage\s+\d+\b/gi, "Page #")
    .replace(/\s+\d+\s*$/, " #")
    .toLowerCase();
}

export function removeRepeatedPageFurniture(pages: string[][]) {
  const counts = new Map<string, number>();
  for (const lines of pages) {
    const boundary = [...lines.slice(0, 3), ...lines.slice(-3)];
    const unique = new Set(boundary.map(furnitureKey).filter((line) => line.length >= 5 && line.length <= 180));
    for (const key of unique) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const threshold = Math.max(2, Math.ceil(pages.length * 0.2));
  const repeated = new Set([...counts].filter(([, count]) => count >= threshold).map(([key]) => key));
  return pages.map((lines) =>
    lines
      .map((line, index) => {
        const atBoundary = index < 3 || index >= lines.length - 3;
        if (isPageFurniture(line) || (atBoundary && repeated.has(furnitureKey(line)))) return "";
        return stripKnownPageFurniture(line);
      })
      .filter(Boolean),
  );
}

export function pdfItemsToLines(items: unknown[]) {
  const lines: string[] = [];
  let current = "";
  for (const item of items) {
    if (!item || typeof item !== "object" || !("str" in item)) continue;
    const value = typeof item.str === "string" ? item.str : "";
    if (value) current += `${current && !/\s$/.test(current) ? " " : ""}${value}`;
    if ("hasEOL" in item && item.hasEOL) {
      if (compact(current)) lines.push(compact(current));
      current = "";
    }
  }
  if (compact(current)) lines.push(compact(current));
  return lines;
}

export function pdfItemsToVisualLines(items: unknown[]) {
  const positioned: Array<{ text: string; x: number; y: number; index: number }> = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || typeof item !== "object" || !("str" in item) || !("transform" in item)) continue;
    const text = typeof item.str === "string" ? compact(item.str) : "";
    const transform = Array.isArray(item.transform) ? item.transform : [];
    const x = Number(transform[4]);
    const y = Number(transform[5]);
    if (text && Number.isFinite(x) && Number.isFinite(y)) positioned.push({ text, x, y, index });
  }
  if (!positioned.length) return pdfItemsToLines(items);

  positioned.sort((a, b) => b.y - a.y || a.x - b.x || a.index - b.index);
  const rows: Array<{ y: number; items: typeof positioned }> = [];
  for (const item of positioned) {
    const row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= 2);
    if (row) row.items.push(item);
    else rows.push({ y: item.y, items: [item] });
  }

  return rows
    .sort((a, b) => b.y - a.y)
    .map((row) => compact(row.items.sort((a, b) => a.x - b.x || a.index - b.index).map((item) => item.text).join(" ")))
    .filter(Boolean);
}
