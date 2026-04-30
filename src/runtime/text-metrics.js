import { readFile } from "node:fs/promises";

export function measureText(text) {
  const value = String(text ?? "");
  return {
    chars: value.length,
    lines: value.length ? value.split(/\r?\n/).length : 0,
    bytes: Buffer.byteLength(value, "utf8")
  };
}

export function combineTextMetrics(metrics) {
  return metrics.reduce((sum, item) => ({
    chars: sum.chars + (item?.chars ?? 0),
    lines: sum.lines + (item?.lines ?? 0),
    bytes: sum.bytes + (item?.bytes ?? 0)
  }), { chars: 0, lines: 0, bytes: 0 });
}

export function formatTextMetrics(metrics) {
  return `${metrics.chars} chars / ${metrics.lines} lines / ${metrics.bytes} bytes`;
}

export async function readTextMetrics(filePath) {
  return measureText(await readFile(filePath, "utf8"));
}
