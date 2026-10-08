#!/usr/bin/env node
/**
 * generate_request_flow.mjs
 *
 * Purpose:
 *   Regenerate `docs/sse-protocol.svg`, a sequence diagram of the `POST /chat`
 *   request lifecycle in pi-starter: from HTTP body → agent session.prompt()
 *   → extension hooks (guard / audit) → tool execution → SDK events →
 *   translateEvent() → SSE frames on the wire.
 *
 *   All event names and the tool-result preview limit are read at
 *   generation time from `src/sse.ts` and `src/app.ts` so the diagram
 *   cannot drift from the actual protocol.
 *
 * Dependencies:
 *   Node.js built-ins only (`node:fs`, `node:path`). No npm install required.
 *
 * Run:
 *   node scripts/visualization/generate_request_flow.mjs
 *
 * Output:
 *   docs/sse-protocol.svg (1040 x 640, English text nodes per repo doc policy)
 *
 * Notes:
 *   - Text inside SVG is English; Chinese explanations live in the README figure caption.
 *   - One file only, no language suffix. Both README.md and README.zh-CN.md reference the same file.
 *   - Do NOT delete this script; future diagram updates reuse it.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const outPath = join(repoRoot, "docs", "sse-protocol.svg");

// ---------- truth sources ----------

const sseSrc = readFileSync(join(repoRoot, "src", "sse.ts"), "utf8");
const appSrc = readFileSync(join(repoRoot, "src", "app.ts"), "utf8");

const sseEvents = [...new Set([...sseSrc.matchAll(/sse\(\s*"([a-z_]+)"/g)].map((m) => m[1]))];

// The 6 externally-visible SSE event names; `error` is emitted by app.ts, not sse.ts.
const appErrorEvents = [...new Set([...appSrc.matchAll(/sse\(\s*"([a-z_]+)"/g)].map((m) => m[1]))];
const allEvents = [...new Set([...sseEvents, ...appErrorEvents])];

const previewLimit = (() => {
  const m = sseSrc.match(/TOOL_RESULT_PREVIEW_LIMIT\s*=\s*(\d+)/);
  return m ? Number(m[1]) : null;
})();

// ---------- render ----------

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const W = 1040;
const H = 640;

const C = {
  bg: "#0f172a",
  panel: "#1e293b",
  panelStroke: "#334155",
  text: "#e2e8f0",
  muted: "#94a3b8",
  client: "#38bdf8",
  http: "#22c55e",
  sse: "#a78bfa",
  session: "#facc15",
  guard: "#f472b6",
  tool: "#fb923c",
};

const lanes = [
  { id: "client", title: "Client", color: C.client },
  { id: "http", title: "Express app · src/app.ts", color: C.http },
  { id: "session", title: "Agent session (SDK)", color: C.session },
  { id: "guard", title: "Extensions (guard · audit)", color: C.guard },
  { id: "tool", title: "Tool (src/tools/*)", color: C.tool },
  { id: "sse", title: "SSE translator · src/sse.ts", color: C.sse },
];

const margin = 40;
const headerY = 30;
const headerH = 44;
const laneGap = (W - 2 * margin) / lanes.length;
const laneCenters = lanes.map((_, i) => margin + laneGap * (i + 0.5));

const box = (x, y, w, h, { stroke = C.panelStroke, fill = C.panel, rx = 8 } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="1.2"/>`;

const text = (x, y, t, { size = 12, weight = "400", fill = C.text, anchor = "start" } = {}) =>
  `<text x="${x}" y="${y}" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(t)}</text>`;

const laneHeader = (cx, lane) => {
  const w = laneGap - 20;
  return (
    box(cx - w / 2, headerY, w, headerH, { stroke: lane.color, fill: "#0b1224" }) +
    text(cx, headerY + 20, lane.title, { size: 12, weight: "700", fill: lane.color, anchor: "middle" }) +
    // lifeline
    `<line x1="${cx}" y1="${headerY + headerH}" x2="${cx}" y2="${H - 60}" stroke="${lane.color}" stroke-width="1" stroke-dasharray="4 4" opacity="0.55"/>`
  );
};

// Arrows: from → to with label, y = row
const msg = (fromIdx, toIdx, y, label, { color = C.text, dashed = false, note = null } = {}) => {
  const x1 = laneCenters[fromIdx];
  const x2 = laneCenters[toIdx];
  const dash = dashed ? ' stroke-dasharray="4 4"' : "";
  const arrowHead =
    `<defs><marker id="mk_${Math.round(y)}_${fromIdx}_${toIdx}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${color}"/></marker></defs>`;
  const line = `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${color}" stroke-width="1.6"${dash} marker-end="url(#mk_${Math.round(y)}_${fromIdx}_${toIdx})"/>`;
  const midX = (x1 + x2) / 2;
  const t = text(midX, y - 8, label, { size: 12, fill: color, anchor: "middle" });
  const n = note ? text(midX, y + 18, note, { size: 10, fill: C.muted, anchor: "middle" }) : "";
  return arrowHead + line + t + n;
};

// self message (activation box on a single lane)
const self = (idx, y, label, color) => {
  const cx = laneCenters[idx];
  const w = 60;
  const path = `<path d="M ${cx} ${y} q ${w} 0 ${w} 20 q 0 20 ${-w} 20" stroke="${color}" fill="none" stroke-width="1.6" marker-end="url(#mk_self_${Math.round(y)})"/><defs><marker id="mk_self_${Math.round(y)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${color}"/></marker></defs>`;
  const t = text(cx + 8, y + 34, label, { size: 11, fill: color });
  return path + t;
};

let body = "";
let y = 110;
const rowGap = 42;

// 1. POST /chat
body += msg(0, 1, y, `POST /chat { message }`, { color: C.client, note: "Content-Type: application/json" });
y += rowGap;

// 2. busy check (self on http)
body += self(1, y, `busy? → 429`, C.http);
y += rowGap + 10;

// 3. session.prompt
body += msg(1, 2, y, `session.prompt(userMessage)`, { color: C.http });
y += rowGap;

// 4. SDK → tool_call event → guard
body += msg(2, 3, y, `event: tool_call`, { color: C.session, note: `pi.on("tool_call", …) → { block?, mutate? }` });
y += rowGap;

// 5. guard → tool (allow)
body += msg(3, 4, y, `allowed → execute tool`, { color: C.guard });
y += rowGap;

// 6. tool → SDK result
body += msg(4, 2, y, `tool result`, { color: C.tool, dashed: true, note: previewLimit ? `text preview capped at ${previewLimit} chars` : null });
y += rowGap;

// 7. SDK → tool_result → audit
body += msg(2, 3, y, `event: tool_result`, { color: C.session, note: `pi.on("tool_result", …) → rewrite?` });
y += rowGap;

// 8. SDK streams message_update → SSE translator
body += msg(2, 5, y, `message_update / tool_execution_*`, { color: C.session });
y += rowGap;

// 9. translateEvent
body += self(5, y, `translateEvent(event)`, C.sse);
y += rowGap + 10;

// 10. SSE frames back to client
body += msg(5, 0, y, `SSE frames`, { color: C.sse, note: "data: {type,data}\\n\\n" });
y += rowGap + 6;

// Legend: SSE event types emitted to the client (real names from sse.ts + app.ts)
const legendY = H - 90;
const legendX = margin;
const legendW = W - 2 * margin;
const legendH = 70;
let legend = box(legendX, legendY, legendW, legendH, { stroke: C.sse, fill: "#0b1224" });
legend += text(legendX + 16, legendY + 22, `SSE event vocabulary (${allEvents.length} types)`, { size: 13, weight: "700", fill: C.sse });
allEvents.forEach((ev, i) => {
  const px = legendX + 16 + i * 150;
  const py = legendY + 46;
  legend +=
    `<rect x="${px}" y="${py}" width="130" height="20" rx="4" fill="${C.sse}" opacity="0.14" stroke="${C.sse}" stroke-width="1"/>` +
    text(px + 65, py + 14, ev, { size: 11, fill: C.sse, anchor: "middle" });
});

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="pi-starter POST /chat SSE lifecycle">
  <title>POST /chat SSE lifecycle</title>
  <desc>Sequence diagram: HTTP client → Express app → agent session → extensions (guard / audit) → tool → SSE translator → back to client. Event names and preview limit are read from src/sse.ts and src/app.ts at generation time.</desc>
  <style>
    svg { background: ${C.bg}; }
    text { paint-order: stroke fill; }
  </style>
  <rect x="0" y="0" width="${W}" height="${H}" fill="${C.bg}"/>
  ${lanes.map((lane, i) => laneHeader(laneCenters[i], lane)).join("\n")}
  <text x="${W / 2}" y="${H - 100}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="14" font-weight="700" fill="${C.text}" text-anchor="middle">Request lifecycle</text>
  ${body}
  ${legend}
</svg>
`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, svg, "utf8");

console.log("wrote", outPath);
console.log("  sse events      :", allEvents.join(", "));
console.log("  preview limit   :", previewLimit);
