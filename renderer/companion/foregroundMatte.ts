import { KEY_BACKGROUND, KEY_FOREGROUND, screenStrength, type KeyColor } from './keyColor';

/** Protect ONLY ambiguous green tint enclosed by confident foreground. Border-connected shadows stay unprotected;
 *  exact screen green stays transparent even in enclosed arm/leg gaps. Not semantic person segmentation / hole fill.
 *  O(width*height), normally on a <=160px thumbnail. Queue entries are visited at most once. */
export function foregroundProtection(pixels: ArrayLike<number>, width: number, height: number, key: KeyColor, tolerance = 3): Uint8Array {
  const size = width * height, candidate = new Uint8Array(size), protectable = new Uint8Array(size), reached = new Uint8Array(size), queue = new Uint32Array(size);
  for (let p = 0; p < size; p++) {
    const i = p * 4, r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], s = screenStrength(r, g, b, key);
    if (pixels[i + 3] < 128 || g - Math.max(r, b) > tolerance && s > KEY_FOREGROUND) candidate[p] = 1;
    // Include solid foreground in the mask: a downsampled dark print must not punch unprotected pinholes into
    // adjacent ambiguous clothing at full resolution. The shader still checks true screen neighbors for edges.
    if (pixels[i + 3] >= 128 && s < KEY_BACKGROUND) protectable[p] = 1;
  }
  let head = 0, tail = 0;
  const visit = (p: number) => { if (candidate[p] && !reached[p]) { reached[p] = 1; queue[tail++] = p; } };
  for (let x = 0; x < width; x++) { visit(x); visit((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { visit(y * width); visit(y * width + width - 1); }
  while (head < tail) {
    const p = queue[head++], x = p % width;
    if (x) visit(p - 1); if (x + 1 < width) visit(p + 1);
    if (p >= width) visit(p - width); if (p + width < size) visit(p + width);
  }
  for (let p = 0; p < size; p++) protectable[p] = protectable[p] && !reached[p] ? 255 : 0;
  return protectable;
}
