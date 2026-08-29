/* A shapefile reader, for the one shapefile this repo reads.
 *
 * Statistics Canada publishes the Forward Sortation Area boundaries as a
 * zipped ESRI shapefile and in no other format. It is 297MB of .shp beside a
 * 155KB .dbf, so this reads the attribute table first, decides which records
 * it wants, and then seeks to exactly those in the geometry file rather than
 * parsing a third of a gigabyte to keep 500 polygons.
 *
 * SCOPE. Shape type 5 (Polygon) and .dbf character fields, which is what this
 * file contains. Anything else throws rather than being guessed at: a reader
 * that silently mishandles a shape type it has never seen is worse than one
 * that stops. Both formats are documented by ESRI and stable since 1998.
 *
 * Everything is little-endian except the .shp record headers and the file
 * header's first fields, which are big-endian. That is the format, not a bug.
 */

import { openSync, readSync, closeSync, statSync } from 'node:fs';

/* ------------------------------------------------------------------ *
 * .dbf: the attribute table
 * ------------------------------------------------------------------ */

/** -> { fields: [name], rows: [{ name: value }] }. Character fields only. */
export function readDbf(path) {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(32);
    readSync(fd, head, 0, 32, 0);
    const recordCount = head.readUInt32LE(4);
    const headerLen = head.readUInt16LE(8);
    const recordLen = head.readUInt16LE(10);

    const descriptors = Buffer.alloc(headerLen - 32);
    readSync(fd, descriptors, 0, descriptors.length, 32);
    const fields = [];
    for (let off = 0; off + 32 <= descriptors.length; off += 32) {
      if (descriptors[off] === 0x0d) break;      // header terminator
      const name = descriptors.toString('latin1', off, off + 11).replace(/\0.*$/, '');
      if (!name) break;
      fields.push({ name, length: descriptors[off + 16] });
    }

    const body = Buffer.alloc(recordLen * recordCount);
    readSync(fd, body, 0, body.length, headerLen);
    const rows = [];
    for (let r = 0; r < recordCount; r += 1) {
      const base = r * recordLen;
      if (body[base] === 0x2a) { rows.push(null); continue; }   // deleted
      const row = {};
      let off = base + 1;
      for (const f of fields) {
        row[f.name] = body.toString('latin1', off, off + f.length).trim();
        off += f.length;
      }
      rows.push(row);
    }
    return { fields: fields.map((f) => f.name), rows };
  } finally {
    closeSync(fd);
  }
}

/* ------------------------------------------------------------------ *
 * .shx / .shp: the geometry
 * ------------------------------------------------------------------ */

/** The index: byte offset and length of every record, in record order. */
function readShx(path) {
  const size = statSync(path).size;
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, 0);
    const out = [];
    for (let off = 100; off + 8 <= size; off += 8) {
      out.push({ offset: buf.readInt32BE(off) * 2, length: buf.readInt32BE(off + 4) * 2 });
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

/**
 * Read only the records `want(i, row)` returns true for.
 *
 * -> Map(recordIndex -> rings), each ring an array of [x, y] in the file's own
 * CRS. Nothing is reprojected here: the caller knows what the .prj says.
 */
export function readPolygons(shpPath, shxPath, want) {
  const index = readShx(shxPath);
  const fd = openSync(shpPath, 'r');
  try {
    const out = new Map();
    for (let i = 0; i < index.length; i += 1) {
      if (!want(i)) continue;
      const { offset, length } = index[i];
      const buf = Buffer.alloc(length + 8);
      readSync(fd, buf, 0, buf.length, offset);
      /* 8 bytes of record header, then the shape itself. */
      const type = buf.readInt32LE(8);
      if (type === 0) continue;                    // null shape, legal
      if (type !== 5) {
        throw new Error(`shapefile record ${i} is shape type ${type}; this reader handles 5 (Polygon)`);
      }
      const numParts = buf.readInt32LE(8 + 36);
      const numPoints = buf.readInt32LE(8 + 40);
      const partsAt = 8 + 44;
      const pointsAt = partsAt + numParts * 4;
      const starts = [];
      for (let p = 0; p < numParts; p += 1) starts.push(buf.readInt32LE(partsAt + p * 4));
      starts.push(numPoints);

      const rings = [];
      for (let p = 0; p < numParts; p += 1) {
        const ring = [];
        for (let q = starts[p]; q < starts[p + 1]; q += 1) {
          const at = pointsAt + q * 16;
          ring.push([buf.readDoubleLE(at), buf.readDoubleLE(at + 8)]);
        }
        rings.push(ring);
      }
      out.set(i, rings);
    }
    return out;
  } finally {
    closeSync(fd);
  }
}
