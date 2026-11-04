// Images identified from their bytes, for the Console's image tools.

/** The accepted types: PNG, JPEG and WebP images, identified from the
 * bytes (never from a name or a declared type). SVG and everything else is
 * refused (SVG can carry script). */
type ImageMime = "image/png" | "image/jpeg" | "image/webp";
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** The image type and size, read from the bytes, or null when the bytes are
 * not a complete PNG, JPEG or WebP header. */
export function sniffImage(bytes: Buffer): { mime: ImageMime; width: number; height: number } | null {
  // PNG: signature, then the IHDR chunk's width and height.
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
    bytes.toString("latin1", 12, 16) === "IHDR"
  )
    return { mime: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  // JPEG: SOI, then segments until a start-of-frame marker.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null;
      // Any number of 0xff fill bytes may precede a marker.
      while (bytes[at + 1] === 0xff && at + 2 < bytes.length) at++;
      const marker = bytes[at + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        at += 2;
        continue;
      }
      const length = bytes.readUInt16BE(at + 2);
      const frame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (frame)
        return { mime: "image/jpeg", height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
      if (length < 2) return null;
      at += 2 + length;
    }
    return null;
  }
  // WebP: RIFF container with a VP8, VP8L or VP8X chunk.
  if (bytes.length >= 30 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") {
    const chunk = bytes.toString("latin1", 12, 16);
    if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a)
      return {
        mime: "image/webp",
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      };
    if (chunk === "VP8L" && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      return { mime: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X")
      return {
        mime: "image/webp",
        width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
        height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
      };
  }
  return null;
}
