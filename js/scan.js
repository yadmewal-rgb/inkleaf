// Camera scans: the photographed page is straightened from its four corners and, unless kept in colour,
// its shadows are evened out (and for "doc", the paper turned white and the writing darkened).
// Works on pictures only; the editor turns the result into a page.
import { clamp } from './util.js';

// src: {img, w, h}; q: the four corners as fractions of the picture (top left, top right, bottom right, bottom
// left); mode: 'color', 'gray' or 'doc'. Returns {blob (JPEG), W, H}.
export async function straightenScan(src, q, mode) {
  // Work on a copy no bigger than 2400 px.
  const k = Math.min(1, 2400 / Math.max(src.w, src.h)), SW = Math.round(src.w * k), SH = Math.round(src.h * k);
  const sc = document.createElement('canvas');
  sc.width = SW; sc.height = SH;
  const sx = sc.getContext('2d');
  sx.drawImage(src.img, 0, 0, SW, SH);
  const S = sx.getImageData(0, 0, SW, SH).data;
  const P = q.map(([x, y]) => [x * SW, y * SH]);
  const len = (a, c) => Math.hypot(a[0] - c[0], a[1] - c[1]);
  let W = (len(P[0], P[1]) + len(P[3], P[2])) / 2, H = (len(P[0], P[3]) + len(P[1], P[2])) / 2;
  const f = 1800 / Math.max(W, H);
  W = Math.max(50, Math.round(W * f)); H = Math.max(50, Math.round(H * f));
  // Unit square -> the chosen corners (projective mapping).
  const [x0, y0] = P[0], [x1, y1] = P[1], [x2, y2] = P[2], [x3, y3] = P[3];
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3, dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let a, bb, c, d, e2, f2, g = 0, hh = 0;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) { a = x1 - x0; bb = x2 - x1; c = x0; d = y1 - y0; e2 = y2 - y1; f2 = y0; }
  else {
    const det = dx1 * dy2 - dx2 * dy1;
    g = (dx3 * dy2 - dx2 * dy3) / det; hh = (dx1 * dy3 - dx3 * dy1) / det;
    a = x1 - x0 + g * x1; bb = x3 - x0 + hh * x3; c = x0; d = y1 - y0 + g * y1; e2 = y3 - y0 + hh * y3; f2 = y0;
  }
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const ox = out.getContext('2d'), O = ox.createImageData(W, H), D = O.data;
  const lum = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    const v = (j + 0.5) / H;
    for (let i = 0; i < W; i++) {
      const u = (i + 0.5) / W, z = g * u + hh * v + 1;
      const X = clamp((a * u + bb * v + c) / z, 0, SW - 1.001), Y = clamp((d * u + e2 * v + f2) / z, 0, SH - 1.001);
      const xi = X | 0, yi = Y | 0, fx = X - xi, fy = Y - yi, p = (yi * SW + xi) * 4, o = (j * W + i) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = S[p + ch] * (1 - fx) + S[p + 4 + ch] * fx, bot = S[p + SW * 4 + ch] * (1 - fx) + S[p + SW * 4 + 4 + ch] * fx;
        D[o + ch] = top * (1 - fy) + bot * fy;
      }
      D[o + 3] = 255;
      lum[j * W + i] = 0.299 * D[o] + 0.587 * D[o + 1] + 0.114 * D[o + 2];
    }
  }
  if (mode !== 'color') {
    // Even out shadows: estimate the paper's brightness in blocks, then divide it out.
    const B = 40, bw = Math.ceil(W / B), bh = Math.ceil(H / B), bgv = new Float32Array(bw * bh);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      const hist = new Uint32Array(64);
      let n = 0;
      for (let y = by * B; y < Math.min(H, by * B + B); y += 2) for (let x = bx * B; x < Math.min(W, bx * B + B); x += 2) { hist[lum[y * W + x] >> 2]++; n++; }
      let acc = 0, k2 = 63;
      for (; k2 > 0; k2--) { acc += hist[k2]; if (acc >= n * 0.2) break; }
      bgv[by * bw + bx] = Math.max(40, k2 * 4 + 2);
    }
    const bgAt = (x, y) => {
      const fx = clamp(x / B - 0.5, 0, bw - 1), fy = clamp(y / B - 0.5, 0, bh - 1), ix = Math.min(bw - 2, fx | 0), iy = Math.min(bh - 2, fy | 0);
      if (bw < 2 || bh < 2) return bgv[0];
      const tx2 = fx - ix, ty2 = fy - iy;
      return (bgv[iy * bw + ix] * (1 - tx2) + bgv[iy * bw + ix + 1] * tx2) * (1 - ty2) + (bgv[(iy + 1) * bw + ix] * (1 - tx2) + bgv[(iy + 1) * bw + ix + 1] * tx2) * ty2;
    };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      let r = lum[y * W + x] / bgAt(x, y);
      if (mode === 'doc') r = r > 0.9 ? 1 : Math.pow(Math.max(0, (r - 0.2) / 0.7), 1.4);
      const val = clamp(Math.round(r * 255), 0, 255);
      D[o] = D[o + 1] = D[o + 2] = val;
    }
  }
  ox.putImageData(O, 0, 0);
  const blob = await new Promise(res => out.toBlob(res, 'image/jpeg', 0.86));
  return { blob, W, H };
}
