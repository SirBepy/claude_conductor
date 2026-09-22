export function buildPieSvg(
  slices: { value: number; color: string }[],
  total: number,
  opts: { r: number; cx: number; cy: number; size: number },
): string {
  const { r, cx, cy, size } = opts;
  let acc = 0;
  const paths = slices
    .map((slice) => {
      const start = (acc / total) * Math.PI * 2 - Math.PI / 2;
      acc += slice.value;
      const end = (acc / total) * Math.PI * 2 - Math.PI / 2;
      const large = end - start > Math.PI ? 1 : 0;
      const x1 = cx + Math.cos(start) * r;
      const y1 = cy + Math.sin(start) * r;
      const x2 = cx + Math.cos(end) * r;
      const y2 = cy + Math.sin(end) * r;
      return `<path d="M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z" fill="${slice.color}" stroke="var(--color-surface)" stroke-width="1.5" />`;
    })
    .join("");
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${paths}</svg>`;
}
