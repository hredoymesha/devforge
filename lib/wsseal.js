/*
 * Workspace encryption at rest (optional, tied to Owner mode). Pure functions over lib/owner.js so
 * they can be tested in Node; lib/store.js applies them when IndexedDB is read and written.
 *
 * What is encrypted: title, url and payload of each item (the part that can hold captured pages,
 * reports and screenshots). What stays readable: id, project, kind and created, because lists,
 * ordering and per-project views need them without the passphrase. Those four fields are
 * authenticated, so editing them in the database makes the record fail to open instead of silently
 * changing what it means.
 *
 * What it cannot do: it does not protect data while Owner mode is unlocked, from code running in an
 * unlocked extension page, or from someone who can replace the extension's files.
 */
const DFWsSeal = (() => {
  const O = typeof DFOwner !== 'undefined' ? DFOwner : require('./owner.js');
  const META = ['id', 'project', 'kind', 'created'];

  const context = (rec) => 'ws:' + META.map((k) => String(rec[k])).join('|');
  const meta = (rec) => Object.fromEntries(META.map((k) => [k, rec[k]]));
  const isSealed = (rec) => !!(rec && rec.sealed);

  async function sealItem(key, item) {
    if (!item || !item.id) throw new Error('Cannot seal an item without an id.');
    const rest = Object.fromEntries(Object.entries(item).filter(([k]) => !META.includes(k)));
    const rec = meta(item);
    return { ...rec, sealed: await O.seal(key, rest, context(rec)) };
  }

  async function revealItem(key, rec) {
    if (!isSealed(rec)) return rec;
    const rest = await O.open(key, rec.sealed, context(rec));
    return { ...meta(rec), ...rest };
  }

  // What the interface shows for a record that cannot be opened right now.
  const lockedView = (rec) => ({ ...meta(rec), title: 'Sealed item', url: '', payload: null, locked: true });

  // Key-order-independent text form, for comparing a record with its decrypted copy.
  const canonical = (v) =>
    JSON.stringify(v, (_, x) =>
      x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x
    );

  return { META, isSealed, sealItem, revealItem, lockedView, context, canonical };
})();
if (typeof module !== 'undefined') module.exports = DFWsSeal;
