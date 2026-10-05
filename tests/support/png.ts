import { inflateSync } from "node:zlib";

export interface Png {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, rows top to bottom. */
  pixels: Uint8Array;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * Decodes the 8-bit, non-interlaced greyscale, RGB and RGBA PNGs StarUML's exporter writes
 * (Chromium's canvas encoder), enough to compare two renderings pixel by pixel in the live suite.
 */
export function decodePng(base64: string): Png {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const data: Buffer[] = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      colorType = chunk[9]!;
      if (chunk[8] !== 8 || chunk[12] !== 0) throw new Error("only 8-bit non-interlaced PNGs");
    } else if (type === "IDAT") {
      data.push(chunk);
    }
    offset += 12 + length;
  }
  const channels = CHANNELS[colorType];
  if (channels === undefined) throw new Error(`colour type ${colorType} is not supported`);
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? rows[y * stride + x - channels]! : 0;
      const b = y > 0 ? rows[(y - 1) * stride + x]! : 0;
      const c = x >= channels && y > 0 ? rows[(y - 1) * stride + x - channels]! : 0;
      const p = a + b - c;
      const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
      const predictor = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][
        filter
      ]!;
      rows[y * stride + x] = (line[x]! + predictor) & 0xff;
    }
  }
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const px = rows.subarray(i * channels, (i + 1) * channels);
    const [r, g, b, alpha] =
      channels >= 3
        ? [px[0]!, px[1]!, px[2]!, channels === 4 ? px[3]! : 255]
        : [px[0]!, px[0]!, px[0]!, channels === 2 ? px[1]! : 255];
    pixels.set([r, g, b, alpha], i * 4);
  }
  return { width, height, pixels };
}

/** The rows, top to bottom, in which `a` and `b` differ; both must have the same size. */
export function differingRows(a: Png, b: Png): { first: number; last: number } | undefined {
  if (a.width !== b.width || a.height !== b.height) throw new Error("sizes differ");
  let first = -1;
  let last = -1;
  const rowBytes = a.width * 4;
  for (let y = 0; y < a.height; y++) {
    for (let i = y * rowBytes; i < (y + 1) * rowBytes; i++) {
      if (a.pixels[i] !== b.pixels[i]) {
        if (first < 0) first = y;
        last = y;
        break;
      }
    }
  }
  return first < 0 ? undefined : { first, last };
}
