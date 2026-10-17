// Read-only parser for Elden Ring Nightreign .sl2 save files.
// Runs unchanged in the browser and in Node 22+ (both expose WebCrypto as globalThis.crypto).
// Nothing in this module ever writes to the save; it only reads bytes it is handed.
//
// Format notes (ported from github.com/metinc/nightreign-relic-browser, MIT):
//   .sl2 = BND4 container -> 14 entries (USERDATA_00..13), each AES-128-CBC encrypted
//   USERDATA_00..09 = character slots, USERDATA_10 = profile summary (slot names)
//   A relic inventory record is 80 bytes and tagged by byte[3] == 0xC0.

const SAVE_KEY = new Uint8Array([
  0x18, 0xf6, 0x32, 0x66, 0x05, 0xbd, 0x17, 0x8a, 0x55, 0x24, 0x52, 0x3a, 0xc0, 0xa0, 0xc6, 0x09,
]);
const IV_SIZE = 0x10;
const BND4_HEADER_LEN = 64;
const BND4_ENTRY_HEADER_LEN = 32;
const PROFILE_ENTRY_INDEX = 10;
const MAX_CHARACTER_SLOTS = 10;

const ENTRY_MAGIC = [0x40, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff];
const NAME_MARKER = [0x27, 0x00, 0x00, 0x46, 0x41, 0x43, 0x45]; // "'\0\0FACE"
const VALID_B3 = new Set([0x80, 0x81, 0x82, 0x83, 0x84, 0x85]);
const RECORD_SIZE_BY_B4 = { 0x80: 80, 0x90: 16, 0xc0: 80 };
const RELIC_TAG = 0xc0;

export class SaveParseError extends Error {}

const i32 = (d, o) => d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24);
const u24 = (d, o) => d[o] | (d[o + 1] << 8) | (d[o + 2] << 16);
const u16 = (d, o) => d[o] | (d[o + 1] << 8);

function indexOf(data, pattern, from = 0) {
  const first = pattern[0];
  const last = data.length - pattern.length;
  outer: for (let i = Math.max(0, from); i <= last; i++) {
    if (data[i] !== first) continue;
    for (let j = 1; j < pattern.length; j++) if (data[i + j] !== pattern[j]) continue outer;
    return i;
  }
  return -1;
}

async function importKey() {
  return globalThis.crypto.subtle.importKey("raw", SAVE_KEY, { name: "AES-CBC" }, false, ["decrypt"]);
}

/** Decrypts every BND4 entry. Returns Map<entryIndex, Uint8Array plaintext>. */
export async function decryptEntries(buffer) {
  const raw = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (raw.length < BND4_HEADER_LEN || indexOf(raw.subarray(0, 4), [0x42, 0x4e, 0x44, 0x34]) !== 0) {
    throw new SaveParseError("Not a Nightreign save: BND4 header missing. Pick the NR0000.sl2 file.");
  }
  const key = await importKey();
  const count = i32(raw, 12);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    const pos = BND4_HEADER_LEN + BND4_ENTRY_HEADER_LEN * i;
    if (pos + BND4_ENTRY_HEADER_LEN > raw.length) break;
    if (!ENTRY_MAGIC.every((b, j) => raw[pos + j] === b)) continue;
    const size = i32(raw, pos + 8);
    const offset = i32(raw, pos + 16);
    if (size <= IV_SIZE || offset <= 0 || offset + size > raw.length) continue;
    const iv = raw.slice(offset, offset + IV_SIZE);
    const payload = raw.subarray(offset + IV_SIZE, offset + size);
    try {
      const plain = new Uint8Array(await globalThis.crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, payload));
      entries.set(i, plain.subarray(4)); // first 4 bytes are a length prefix
    } catch {
      // A torn read (game mid-write) or a foreign file; skip this entry.
    }
  }
  if (entries.size === 0) throw new SaveParseError("Could not decrypt any entries in this file.");
  return entries;
}

/** Character names live in the profile entry; returns the raw UTF-16LE byte runs used to locate each slot. */
function readSlotNames(profile) {
  const names = [];
  let from = 0;
  for (let i = 0; i < MAX_CHARACTER_SLOTS; i++) {
    const marker = indexOf(profile, NAME_MARKER, from);
    if (marker < 0) break;
    from = marker + NAME_MARKER.length;
    const start = marker - 51;
    const term = indexOf(profile, [0x00, 0x00], start);
    if (start < 0 || term < 0) break;
    names.push(profile.slice(start, term + 1));
  }
  return names;
}

const isRecordStart = (d, p) =>
  p + 4 <= d.length && VALID_B3.has(d[p + 2]) && RECORD_SIZE_BY_B4[d[p + 3]] !== undefined && p + RECORD_SIZE_BY_B4[d[p + 3]] <= d.length;

const isEmptyRecord = (d, p) =>
  p + 8 <= d.length && d[p] === 0 && d[p + 1] === 0 && d[p + 2] === 0 && d[p + 3] === 0 &&
  d[p + 4] === 0xff && d[p + 5] === 0xff && d[p + 6] === 0xff && d[p + 7] === 0xff;

/** Walks the inventory table and returns raw relic records in table order. */
function readRelicRecords(region) {
  let start = -1;
  for (let i = 0; i < region.length - 8; i++) {
    if (!isRecordStart(region, i)) continue;
    const next = i + RECORD_SIZE_BY_B4[region[i + 3]];
    if (isRecordStart(region, next) || isEmptyRecord(region, next)) {
      start = i;
      break;
    }
  }
  if (start < 0) return [];

  const records = [];
  let i = start;
  while (i < region.length - 4) {
    if (isRecordStart(region, i)) {
      const size = RECORD_SIZE_BY_B4[region[i + 3]];
      if (region[i + 3] === RELIC_TAG) {
        const effects = [];
        for (let k = 0; k < 4; k++) {
          const effect = i32(region, i + 16 + k * 4);
          if (effect === -1) continue;
          const curse = i32(region, i + 56 + k * 4);
          effects.push(curse === -1 ? [effect] : [effect, curse]);
        }
        records.push({
          handle: i32(region, i) >>> 0,
          idBytes: region.slice(i, i + 4),
          itemId: u24(region, i + 4),
          effects,
        });
      }
      i += size;
    } else if (isEmptyRecord(region, i)) {
      i += 8;
    } else {
      i += 1;
    }
  }
  return records;
}

/**
 * The acquisition-order table (what the game calls "Order Found") follows the inventory.
 * Each row is [4-byte handle][01 00 00 00][u16 sort key]. Relics with no row were sold/discarded.
 * One forward pass builds handle -> first matching offset, matching the reference parser's
 * "first occurrence after `from`" semantics without an O(relics x bytes) rescan.
 */
function readSortKeys(data, from) {
  const firstOffset = new Map();
  for (let p = Math.max(0, from); p + 10 <= data.length; p++) {
    if (data[p + 4] !== 0x01 || data[p + 5] !== 0 || data[p + 6] !== 0 || data[p + 7] !== 0) continue;
    const handle = i32(data, p) >>> 0;
    if (!firstOffset.has(handle)) firstOffset.set(handle, p);
  }
  return firstOffset;
}

function parseCharacter(nameBytes, data) {
  const name = new TextDecoder("utf-16le").decode(nameBytes).replace(/\0+$/, "");
  const anchor = indexOf(data, nameBytes);
  if (anchor < 0) return { name, relics: [], warning: "Character name not found in slot data" };
  const tableEnd = indexOf(data, [0xff, 0xff, 0xff, 0xff], anchor + 1000);
  if (tableEnd < 0) return { name, relics: [], warning: "Inventory end marker not found" };

  const records = readRelicRecords(data.subarray(32, anchor - 100));
  const offsets = readSortKeys(data, tableEnd);
  const relics = [];
  for (const r of records) {
    const off = offsets.get(r.handle);
    if (off === undefined) continue; // not in the owned list anymore
    relics.push({ handle: r.handle, itemId: r.itemId, effects: r.effects, sortKey: u16(data, off + 8) });
  }
  // Newest first = in-game "Order Found"
  relics.sort((a, b) => b.sortKey - a.sortKey);
  return { name, relics };
}

/**
 * Parses an .sl2 buffer into { slots: [{ index, name, relics: [{ handle, itemId, effects, sortKey }] }] }.
 * `effects` is a list of [effectId] or [effectId, curseId] using the game's raw param ids.
 */
export async function parseSave(buffer) {
  const entries = await decryptEntries(buffer);
  const profile = entries.get(PROFILE_ENTRY_INDEX);
  if (!profile) throw new SaveParseError("Profile entry (USERDATA_10) missing or unreadable.");
  const slots = [];
  readSlotNames(profile).forEach((nameBytes, index) => {
    const data = entries.get(index);
    if (!data) return;
    slots.push({ index, ...parseCharacter(nameBytes, data) });
  });
  return { slots, entryCount: entries.size };
}
