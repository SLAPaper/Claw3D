const MAX_NAMEPLATE_DISPLAY_UNITS = 10;
const MAX_SUBTITLE_DISPLAY_UNITS = 18;
const MAX_SPEECH_BUBBLE_DISPLAY_UNITS = 220;
const DEFAULT_SPEECH_BUBBLE_LINE_UNITS = 34;
const DEFAULT_SPEECH_BUBBLE_LINES = 4;
const ELLIPSIS = "…";

const normalizeInlineText = (value: string) => value.replace(/\s+/g, " ").trim();

const isWideCodePoint = (codePoint: number) =>
  (codePoint >= 0x1100 && codePoint <= 0x115f) ||
  (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
  (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
  (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
  (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
  (codePoint >= 0xff00 && codePoint <= 0xffef) ||
  (codePoint >= 0x1f300 && codePoint <= 0x1faff);

export const measureDisplayUnits = (value: string): number =>
  Array.from(value).reduce((total, char) => {
    if (!char.trim()) return total + 0.5;
    const codePoint = char.codePointAt(0) ?? 0;
    if (char === ELLIPSIS) return total + 1.5;
    return total + (isWideCodePoint(codePoint) ? 2 : 1);
  }, 0);

export const truncateTextByDisplayUnits = (
  value: string,
  maxUnits: number,
): string => {
  const normalized = normalizeInlineText(value);
  if (!normalized) return "";
  if (measureDisplayUnits(normalized) <= maxUnits) return normalized;

  const ellipsisUnits = measureDisplayUnits(ELLIPSIS);
  let next = "";
  let units = 0;
  for (const char of Array.from(normalized)) {
    const charUnits = measureDisplayUnits(char);
    if (units + charUnits + ellipsisUnits > maxUnits) break;
    next += char;
    units += charUnits;
  }
  return next ? `${next}${ELLIPSIS}` : ELLIPSIS;
};

export const formatAgentNameplateText = (value: string): string => {
  const normalized = normalizeInlineText(value);
  if (!normalized) return "";
  if (measureDisplayUnits(normalized) <= MAX_NAMEPLATE_DISPLAY_UNITS) {
    return normalized;
  }

  const [firstName] = normalized.split(" ");
  if (
    firstName &&
    firstName !== normalized &&
    measureDisplayUnits(firstName) <= MAX_NAMEPLATE_DISPLAY_UNITS
  ) {
    return firstName;
  }
  return truncateTextByDisplayUnits(normalized, MAX_NAMEPLATE_DISPLAY_UNITS);
};

export const formatAgentSubtitleText = (value: string): string =>
  truncateTextByDisplayUnits(value, MAX_SUBTITLE_DISPLAY_UNITS);

export const flattenSpeechBubbleMarkdown = (value: string) =>
  value
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^>\s*/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export const clampSpeechBubbleText = (value: string) =>
  measureDisplayUnits(value) <= MAX_SPEECH_BUBBLE_DISPLAY_UNITS
    ? { text: value, truncated: false }
    : {
        text: truncateTextByDisplayUnits(
          value,
          MAX_SPEECH_BUBBLE_DISPLAY_UNITS,
        ),
        truncated: true,
      };

const pushWrappedLine = (lines: string[], line: string) => {
  const trimmed = line.trim();
  if (trimmed) lines.push(trimmed);
};

export const wrapTextByDisplayUnits = (
  value: string,
  maxUnits: number,
  maxLines: number,
): { lines: string[]; truncated: boolean } => {
  const normalized = normalizeInlineText(value);
  if (!normalized) return { lines: [], truncated: false };

  const lines: string[] = [];
  let current = "";
  let truncated = false;
  const chars = Array.from(normalized);

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index] ?? "";
    if (!current && !char.trim()) continue;
    const candidate = `${current}${char}`;
    if (!current || measureDisplayUnits(candidate) <= maxUnits) {
      current = candidate;
      continue;
    }

    pushWrappedLine(lines, current);
    if (lines.length >= maxLines) {
      truncated = true;
      break;
    }
    current = char.trimStart();
  }

  if (!truncated && current && lines.length < maxLines) {
    pushWrappedLine(lines, current);
  }

  if (!truncated && lines.length > maxLines) {
    truncated = true;
  }
  const boundedLines = lines.slice(0, maxLines);

  if (truncated && boundedLines.length > 0) {
    boundedLines[boundedLines.length - 1] = truncateTextByDisplayUnits(
      `${boundedLines[boundedLines.length - 1]}${ELLIPSIS}`,
      maxUnits,
    );
  }

  return { lines: boundedLines, truncated };
};

export const buildSpeechBubbleTextLayout = (
  value: string,
  maxLineUnits = DEFAULT_SPEECH_BUBBLE_LINE_UNITS,
  maxLines = DEFAULT_SPEECH_BUBBLE_LINES,
) => {
  const flattened = flattenSpeechBubbleMarkdown(value);
  const clamped = clampSpeechBubbleText(flattened);
  const wrapped = wrapTextByDisplayUnits(clamped.text, maxLineUnits, maxLines);
  return {
    lines: wrapped.lines,
    text: wrapped.lines.join("\n"),
    truncated: clamped.truncated || wrapped.truncated,
    maxLineUnits,
  };
};
