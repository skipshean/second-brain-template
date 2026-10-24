export type CuratedAction = {
  title: string;
  assigneeName?: string;
  ownerHeading?: string;
};

const FIREFLIES_HEADER = /^action items?:?\s*$/i;
const MD_HEADER_LINE = /^(#{1,6})\s+(.+?)\s*:?\s*$/;
const CURATED_HEADER_KEYWORDS = /^(next steps|action items|next actions|to[- ]?do)$/i;
const SECTION_TERMINATOR = /^(summary|transcript|notes)\s*:?\s*$/i;
const HORIZONTAL_RULE = /^---+\s*$/;

type Captured = {
  lines: string[];
  style: "fireflies" | "granola";
};

export function extractCuratedActions(body: string): CuratedAction[] | null {
  const captured = captureCuratedBlock(body);
  if (!captured) return null;
  return parseBlock(captured);
}

function captureCuratedBlock(body: string): Captured | null {
  // Note: we only recognize ATX-style markdown headings (leading `#` chars);
  // setext underline headings (===/---) are intentionally not supported
  // because the known upstream sources (Fireflies, Granola) don't emit them.
  const raw = body.split(/\r?\n/);
  // Granola-style markdown heading first (stronger signal).
  for (let i = 0; i < raw.length; i += 1) {
    const line = raw[i] ?? "";
    const mh = line.match(MD_HEADER_LINE);
    if (mh) {
      const levelPrefix = mh[1] ?? "";
      const title = (mh[2] ?? "").trim();
      if (!CURATED_HEADER_KEYWORDS.test(title)) continue;
      const captured: string[] = [];
      const level = levelPrefix.length;
      for (let j = i + 1; j < raw.length; j += 1) {
        const cur = raw[j] ?? "";
        if (HORIZONTAL_RULE.test(cur)) break;
        const nextHeader = cur.match(MD_HEADER_LINE);
        if (nextHeader && (nextHeader[1] ?? "").length <= level) break;
        if (/^transcript\s*:?\s*$/i.test(cur.trim())) break;
        captured.push(cur);
      }
      return { lines: captured, style: "granola" };
    }
  }
  // Fireflies-style plain "Action Items:" marker.
  for (let i = 0; i < raw.length; i += 1) {
    const line = (raw[i] ?? "").trim();
    if (!FIREFLIES_HEADER.test(line)) continue;
    const captured: string[] = [];
    for (let j = i + 1; j < raw.length; j += 1) {
      const cur = raw[j] ?? "";
      const trimmed = cur.trim();
      if (HORIZONTAL_RULE.test(cur)) break;
      if (SECTION_TERMINATOR.test(trimmed)) break;
      captured.push(cur);
    }
    return { lines: captured, style: "fireflies" };
  }
  return null;
}

function parseBlock(block: Captured): CuratedAction[] {
  const out: CuratedAction[] = [];
  let currentOwner: { name: string; heading: string } | null = null;

  const bullets = collapseToBullets(block.lines);
  for (const bullet of bullets) {
    const ownerLabel = detectOwnerLabel(bullet);
    if (ownerLabel && bullet.indent === 0) {
      currentOwner = ownerLabel;
      continue;
    }
    const title = bullet.text.trim();
    if (!title) continue;

    const inlineColon = parseInlineOwner(title);
    if (inlineColon) {
      out.push({
        title: inlineColon.title,
        assigneeName: inlineColon.assigneeName,
      });
      continue;
    }
    const item: CuratedAction = { title };
    if (currentOwner) {
      item.assigneeName = currentOwner.name;
      item.ownerHeading = currentOwner.heading;
    }
    out.push(item);
  }
  return out;
}

type Bullet = { text: string; indent: number };

function collapseToBullets(lines: string[]): Bullet[] {
  const out: Bullet[] = [];
  let current: Bullet | null = null;
  for (const line of lines) {
    const bulletMatch = line.match(/^(\s*)[-*•]\s+(.*)$/);
    if (bulletMatch) {
      if (current) out.push(current);
      const indent = (bulletMatch[1] ?? "").length;
      current = { text: (bulletMatch[2] ?? "").trim(), indent };
      continue;
    }
    if (!line.trim()) {
      if (current) out.push(current);
      current = null;
      continue;
    }
    // Non-bullet line. If it's indented past the current bullet's indent, treat
    // it as a continuation; otherwise start a new implicit bullet (needed for
    // Fireflies-style plain-line action blocks).
    const leadingSpaces = line.match(/^(\s*)/)?.[1]?.length ?? 0;
    if (current && leadingSpaces > current.indent) {
      current.text = `${current.text} ${line.trim()}`.trim();
    } else {
      if (current) out.push(current);
      current = { text: line.trim(), indent: leadingSpaces };
    }
  }
  if (current) out.push(current);
  return out;
}

function detectOwnerLabel(bullet: Bullet): { name: string; heading: string } | null {
  // Owner subsections look like: "- Alex" or "- Casey (Cclient)" — i.e. a capitalized
  // person name (1–2 words) optionally followed by a parenthetical, with no trailing verb.
  // A 3+ word bullet is prose, not a name.
  const text = bullet.text.trim();
  const m = text.match(/^([A-Z][A-Za-z.\-']*(?:\s+[A-Za-z.\-']+)?)(?:\s*\(([^)]+)\))?\s*$/);
  if (!m) return null;
  const name = (m[1] ?? "").trim();
  const heading = m[2] ? `${name} (${m[2].trim()})` : name;
  if (/\b(will|send|draft|follow|review|build|schedule|confirm|prepare|get|keep|find)\b/i.test(name)) {
    return null;
  }
  return { name, heading };
}

function parseInlineOwner(title: string): { title: string; assigneeName: string } | null {
  const m = title.match(/^([A-Z][A-Za-z.\- ]{1,40}):\s+(.+)$/);
  if (!m) return null;
  return { assigneeName: (m[1] ?? "").trim(), title: (m[2] ?? "").trim() };
}
