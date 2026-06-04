import jsPDF from "jspdf";
import type { HistoryEntry } from "./hivemind-types";

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function wrap(doc: jsPDF, text: string, maxWidth: number): string[] {
  return doc.splitTextToSize(text, maxWidth) as string[];
}

export async function exportRunReport(entry: HistoryEntry, graphCanvas: HTMLCanvasElement | null) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 40;
  const contentW = pageW - margin * 2;
  let y = margin;

  const ensureSpace = (needed: number) => {
    if (y + needed > pageH - margin) {
      doc.addPage();
      y = margin;
    }
  };

  // ── Header band
  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, pageW, 64, "F");
  doc.setFillColor(34, 211, 238);
  doc.rect(0, 64, pageW, 2, "F");

  doc.setTextColor(34, 211, 238);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("HIVEMIND", margin, 32);
  doc.setTextColor(226, 232, 240);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text("Causal Engine — Execution Report", margin, 50);

  doc.setFontSize(9);
  doc.setTextColor(148, 163, 184);
  doc.text(formatTimestamp(entry.timestamp), pageW - margin, 32, { align: "right" });
  doc.text(`Run ${entry.runId}`, pageW - margin, 50, { align: "right" });

  y = 96;

  // ── Task description
  doc.setTextColor(71, 85, 105);
  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.text("EVENT SPACE", margin, y);
  y += 12;
  doc.setTextColor(15, 23, 42);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  const taskLines = wrap(doc, entry.taskFull, contentW);
  doc.text(taskLines, margin, y);
  y += taskLines.length * 13 + 10;

  // ── Metrics
  ensureSpace(80);
  doc.setDrawColor(226, 232, 240);
  doc.setLineWidth(0.5);
  doc.line(margin, y, pageW - margin, y);
  y += 14;

  const ate = entry.payload.impact.ate;
  const conf = entry.payload.impact.confidence.toUpperCase();
  doc.setFontSize(8);
  doc.setTextColor(71, 85, 105);
  doc.setFont("helvetica", "bold");
  doc.text("IMPACT · ATE", margin, y);
  doc.text("CONFIDENCE", margin + contentW / 2, y);
  y += 18;
  doc.setFontSize(28);
  doc.setTextColor(15, 23, 42);
  doc.text(ate == null ? "WITHHELD" : ate.toFixed(2), margin, y);

  // confidence pill
  const confColors: Record<string, [number, number, number]> = {
    HIGH: [16, 185, 129],
    LOW: [244, 63, 94],
  };
  const [cr, cg, cb] = confColors[conf] || [245, 158, 11];
  doc.setFillColor(cr, cg, cb);
  const pillX = margin + contentW / 2;
  doc.roundedRect(pillX, y - 16, 70, 22, 11, 11, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(11);
  doc.text(conf, pillX + 35, y - 1, { align: "center" });

  y += 18;

  // ── Strategies
  ensureSpace(40);
  y += 12;
  doc.setDrawColor(226, 232, 240);
  doc.line(margin, y, pageW - margin, y);
  y += 18;
  doc.setFontSize(11);
  doc.setTextColor(15, 23, 42);
  doc.setFont("helvetica", "bold");
  doc.text(`Strategies (${entry.payload.strategies.length})`, margin, y);
  y += 16;

  for (const [idx, s] of entry.payload.strategies.entries()) {
    ensureSpace(110);
    // card
    doc.setDrawColor(226, 232, 240);
    doc.setFillColor(248, 250, 252);
    const cardTop = y;
    doc.roundedRect(margin, cardTop, contentW, 96, 6, 6, "FD");

    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    doc.setFont("helvetica", "normal");
    doc.text(`#${String(idx + 1).padStart(2, "0")}`, margin + 12, cardTop + 16);

    doc.setFontSize(11);
    doc.setTextColor(15, 23, 42);
    doc.setFont("helvetica", "bold");
    doc.text(s.title, margin + 36, cardTop + 16);

    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(71, 85, 105);
    const sumLines = wrap(doc, s.summary, contentW - 24).slice(0, 3);
    doc.text(sumLines, margin + 12, cardTop + 32);

    // score bars
    const bars = [
      { label: "RISK", value: s.risk_score, color: [244, 63, 94] as [number, number, number] },
      { label: "COST", value: s.cost_score, color: [245, 158, 11] as [number, number, number] },
      { label: "SPEED", value: s.speed_score, color: [16, 185, 129] as [number, number, number] },
    ];
    const barTop = cardTop + 70;
    const barW = (contentW - 24 - 16) / 3;
    bars.forEach((b, i) => {
      const x = margin + 12 + i * (barW + 8);
      doc.setFontSize(7);
      doc.setTextColor(100, 116, 139);
      doc.text(`${b.label} · ${(b.value * 100).toFixed(0)}%`, x, barTop);
      doc.setFillColor(226, 232, 240);
      doc.roundedRect(x, barTop + 4, barW, 5, 2.5, 2.5, "F");
      doc.setFillColor(b.color[0], b.color[1], b.color[2]);
      doc.roundedRect(x, barTop + 4, Math.max(2, barW * b.value), 5, 2.5, 2.5, "F");
    });

    y = cardTop + 96 + 10;
  }

  // ── Causal graph snapshot
  if (graphCanvas) {
    doc.addPage();
    y = margin;
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(15, 23, 42);
    doc.text("Causal Graph", margin, y);
    y += 12;
    doc.setFontSize(8);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(100, 116, 139);
    doc.text(
      `${entry.payload.causal_graph.nodes.length} nodes · ${entry.payload.causal_graph.edges.length} edges`,
      margin,
      y,
    );
    y += 12;

    try {
      const dataUrl = graphCanvas.toDataURL("image/png");
      const ratio = graphCanvas.height / graphCanvas.width;
      const imgW = contentW;
      const imgH = Math.min(pageH - margin - y, imgW * ratio);
      doc.addImage(dataUrl, "PNG", margin, y, imgW, imgH);
      y += imgH + 16;
    } catch {
      doc.setTextColor(244, 63, 94);
      doc.text("(Graph snapshot unavailable)", margin, y + 16);
      y += 32;
    }

    // Edges table (compact)
    if (entry.payload.causal_graph.edges.length > 0) {
      ensureSpace(40);
      doc.setFontSize(9);
      doc.setTextColor(15, 23, 42);
      doc.setFont("helvetica", "bold");
      doc.text("Edges", margin, y);
      y += 12;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      for (const e of entry.payload.causal_graph.edges.slice(0, 40)) {
        ensureSpace(14);
        doc.setTextColor(15, 23, 42);
        const line = `${e.source}  →  [${e.relationship}]  →  ${e.target}`;
        const lines = wrap(doc, line, contentW);
        doc.text(lines, margin, y);
        y += lines.length * 11;
      }
    }
  }

  // ── Footer page numbers
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setFontSize(7);
    doc.setTextColor(148, 163, 184);
    doc.text(
      `HiveMind Causal Engine · Run ${entry.runId} · Page ${i} / ${total}`,
      pageW / 2,
      pageH - 16,
      { align: "center" },
    );
  }

  doc.save(`hivemind-${entry.runId}.pdf`);
}
