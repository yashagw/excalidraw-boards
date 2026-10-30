// Small geometry for drawing from the server: where an arrow meets a shape, and
// roughly how big a piece of text is. The browser re-measures text exactly when a
// user edits it; these estimates err on the wide side so labels do not overflow.

export type Point = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number; type: string };

export const ARROW_GAP = 6;
export const LINE_HEIGHT = 1.25;

export const centerOf = (b: Box): Point => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/** The point where a ray from the centre of `b` towards `toward` leaves its outline, `gap` further out. */
export function boundaryPoint(b: Box, toward: Point, gap = ARROW_GAP): Point {
  const c = centerOf(b);
  let dx = toward.x - c.x;
  let dy = toward.y - c.y;
  if (dx === 0 && dy === 0) dy = 1;
  const hw = Math.max(b.width / 2, 0.5);
  const hh = Math.max(b.height / 2, 0.5);
  let t: number;
  if (b.type === "ellipse") t = 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2);
  else if (b.type === "diamond") t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  const len = Math.hypot(dx, dy);
  return { x: c.x + dx * t + (dx / len) * gap, y: c.y + dy * t + (dy / len) * gap };
}

/** The official Excalidraw MCP's `fixedPoint`: [0..1, 0..1] across the shape, e.g. [1, 0.5] = middle of the right side. */
export const anchorPoint = (b: Box, [fx, fy]: [number, number]): Point => ({ x: b.x + fx * b.width, y: b.y + fy * b.height });

// Width of one character as a fraction of the font size, tuned a little wide for Excalifont.
function charWidth(ch: string): number {
  if (ch === " ") return 0.32;
  if (/[iljtfrI.,:;'!|()[\]`]/.test(ch)) return 0.34;
  if (/[mwMW@%&]/.test(ch)) return 0.92;
  if (/[A-Z]/.test(ch)) return 0.7;
  if (/[0-9]/.test(ch)) return 0.6;
  if (/[ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯]/.test(ch)) return 1.05;
  return 0.6;
}

export function lineWidth(line: string, fontSize: number): number {
  let width = 0;
  for (const ch of line) width += charWidth(ch);
  return width * fontSize;
}

export function textSize(text: string, fontSize: number, lineHeight = LINE_HEIGHT) {
  const lines = text.split("\n");
  return {
    width: Math.max(...lines.map((l) => lineWidth(l, fontSize)), 1),
    height: lines.length * fontSize * lineHeight,
  };
}
