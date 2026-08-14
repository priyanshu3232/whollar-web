/* The declarable vocabulary: districts a partner may bid in.
 *
 * WHY THIS EXISTS. Coverage used to be a free-text box. A partner could type
 * "Scarberia" or "downtown-ish", the row wrote, and then no cohort ever matched
 * that coverage cleanly: the declared region IS the bid unit, and a bid unit
 * nobody else spells the same way is a bid unit that never fires. So the field
 * became a controlled vocabulary and this file is the vocabulary.
 *
 * SIZE OF A DISTRICT. Roughly 25k to 40k households: uniform plant, big enough
 * that an incumbent repricing it hurts, small enough to stay coherent. That is
 * why the launch tier splits Scarborough into four and leaves Oshawa whole.
 *
 * NAMES. Municipal and former-municipality names are official. The compass
 * groupings inside them (Scarborough East, North York Central) are ours, and
 * they match the house style already on the site.
 *
 * TIERS. 'launch' is selectable. 'soon' renders in the list, greyed, tagged
 * "Queued for launch", and cannot be picked: a partner should see the ambition
 * without being able to declare into a market Whollar has not opened. That is
 * the same treatment the coverage table already gives a 'soon' row.
 *
 * FSA IS NOT HERE, DELIBERATELY. Serviceability and facilities-owner checks run
 * on FSA, so each district will carry an FSA set as backend data. The GTA
 * structure is well known at the first three characters (M1x Scarborough, M5x
 * downtown, L4/L5 Mississauga and so on), but exact FSA to district assignment
 * has to be validated against a Canada Post boundary file before production,
 * and a fabricated list here would be indistinguishable from a validated one.
 * The console needs id, name, muni, tier and nothing else.
 */

export var DISTRICTS = [
  /* City of Toronto */
  { id: 'scar-sw', name: 'Scarborough Southwest', muni: 'Scarborough', tier: 'launch' },
  { id: 'scar-c', name: 'Scarborough Centre', muni: 'Scarborough', tier: 'launch' },
  { id: 'scar-e', name: 'Scarborough East', muni: 'Scarborough', tier: 'launch' },
  { id: 'scar-n', name: 'Scarborough North', muni: 'Scarborough', tier: 'launch' },
  { id: 'ny-w', name: 'North York West', muni: 'North York', tier: 'launch' },
  { id: 'ny-c', name: 'North York Central', muni: 'North York', tier: 'launch' },
  { id: 'ny-e', name: 'North York East', muni: 'North York', tier: 'launch' },
  { id: 'ny-s', name: 'North York South', muni: 'North York', tier: 'launch' },
  { id: 'etob-l', name: 'Etobicoke Lakeshore', muni: 'Etobicoke', tier: 'launch' },
  { id: 'etob-c', name: 'Etobicoke Centre', muni: 'Etobicoke', tier: 'launch' },
  { id: 'etob-n', name: 'Etobicoke North', muni: 'Etobicoke', tier: 'launch' },
  { id: 'eyork', name: 'East York', muni: 'East York', tier: 'launch' },
  { id: 'york', name: 'York', muni: 'York', tier: 'launch' },
  { id: 'dt-core', name: 'Downtown Core', muni: 'Old Toronto', tier: 'launch' },
  { id: 'dt-e', name: 'Downtown East', muni: 'Old Toronto', tier: 'launch' },
  { id: 'dt-w', name: 'Downtown West', muni: 'Old Toronto', tier: 'launch' },
  { id: 'midtown', name: 'Midtown', muni: 'Old Toronto', tier: 'launch' },
  { id: 'annex', name: 'The Annex', muni: 'Old Toronto', tier: 'launch' },
  { id: 'westend', name: 'West End', muni: 'Old Toronto', tier: 'launch' },
  { id: 'eastend', name: 'East End', muni: 'Old Toronto', tier: 'launch' },
  /* Peel */
  { id: 'miss-cc', name: 'Mississauga City Centre', muni: 'Mississauga', tier: 'launch' },
  { id: 'miss-l', name: 'Mississauga Lakeshore', muni: 'Mississauga', tier: 'launch' },
  { id: 'miss-w', name: 'Mississauga West', muni: 'Mississauga', tier: 'launch' },
  { id: 'miss-e', name: 'Mississauga East', muni: 'Mississauga', tier: 'launch' },
  { id: 'miss-n', name: 'Mississauga North', muni: 'Mississauga', tier: 'launch' },
  { id: 'bram-c', name: 'Brampton Central', muni: 'Brampton', tier: 'launch' },
  { id: 'bram-e', name: 'Brampton East', muni: 'Brampton', tier: 'launch' },
  { id: 'bram-w', name: 'Brampton West', muni: 'Brampton', tier: 'launch' },
  /* York Region */
  { id: 'mark-c', name: 'Markham Centre', muni: 'Markham', tier: 'launch' },
  { id: 'mark-n', name: 'Markham North', muni: 'Markham', tier: 'launch' },
  { id: 'mark-s', name: 'Markham South', muni: 'Markham', tier: 'launch' },
  { id: 'vau-wb', name: 'Vaughan Woodbridge', muni: 'Vaughan', tier: 'launch' },
  { id: 'vau-vmc', name: 'Maple and VMC', muni: 'Vaughan', tier: 'launch' },
  { id: 'vau-th', name: 'Thornhill Vaughan', muni: 'Vaughan', tier: 'launch' },
  { id: 'vau-kl', name: 'Kleinburg', muni: 'Vaughan', tier: 'launch' },
  { id: 'rh-s', name: 'Richmond Hill South', muni: 'Richmond Hill', tier: 'launch' },
  { id: 'rh-n', name: 'Richmond Hill North', muni: 'Richmond Hill', tier: 'launch' },
  /* Queued for launch: outer GTA and beyond, kept at municipality level until
     the household counts there justify splitting them. */
  { id: 'newmarket', name: 'Newmarket', muni: 'York Region', tier: 'soon' },
  { id: 'aurora', name: 'Aurora', muni: 'York Region', tier: 'soon' },
  { id: 'stouffville', name: 'Whitchurch-Stouffville', muni: 'York Region', tier: 'soon' },
  { id: 'georgina', name: 'Georgina', muni: 'York Region', tier: 'soon' },
  { id: 'pickering', name: 'Pickering', muni: 'Durham', tier: 'soon' },
  { id: 'ajax', name: 'Ajax', muni: 'Durham', tier: 'soon' },
  { id: 'whitby', name: 'Whitby', muni: 'Durham', tier: 'soon' },
  { id: 'oshawa', name: 'Oshawa', muni: 'Durham', tier: 'soon' },
  { id: 'clarington', name: 'Clarington', muni: 'Durham', tier: 'soon' },
  { id: 'oakville', name: 'Oakville', muni: 'Halton', tier: 'soon' },
  { id: 'burlington', name: 'Burlington', muni: 'Halton', tier: 'soon' },
  { id: 'milton', name: 'Milton', muni: 'Halton', tier: 'soon' },
  { id: 'haltonhills', name: 'Halton Hills', muni: 'Halton', tier: 'soon' },
  { id: 'caledon', name: 'Caledon', muni: 'Peel', tier: 'soon' },
  { id: 'hamilton', name: 'Hamilton', muni: 'Hamilton', tier: 'soon' },
  { id: 'ottawa', name: 'Ottawa', muni: 'Ottawa', tier: 'soon' }
];

function norm(s) { return String(s === null || s === undefined ? '' : s).trim().toLowerCase(); }

/** The district with this id, or null. */
export function byId(id) {
  var k = norm(id);
  for (var i = 0; i < DISTRICTS.length; i++) if (DISTRICTS[i].id === k) return DISTRICTS[i];
  return null;
}

/**
 * The district with this name, case and space insensitive, or null. This is
 * what turns a typed string back into vocabulary, so Declare can refuse
 * anything that is not one of these.
 */
export function byName(name) {
  var k = norm(name);
  if (!k) return null;
  for (var i = 0; i < DISTRICTS.length; i++) if (norm(DISTRICTS[i].name) === k) return DISTRICTS[i];
  return null;
}

/**
 * Districts matching a typed fragment, in vocabulary order.
 *
 * Municipality is matched as well as name, and on purpose: a partner typing
 * "vaughan" means the four Vaughan districts, two of which (Maple and VMC,
 * Kleinburg) do not carry the word. Matching name only would answer a
 * reasonable question with an empty list.
 */
export function search(q) {
  var k = norm(q);
  if (!k) return DISTRICTS.slice();
  return DISTRICTS.filter(function (d) {
    return norm(d.name).indexOf(k) > -1 || norm(d.muni).indexOf(k) > -1;
  });
}

/** [{ muni, rows }], municipalities in the order the vocabulary lists them. */
export function grouped(list) {
  var out = [];
  var seen = {};
  (list || []).forEach(function (d) {
    if (!Object.prototype.hasOwnProperty.call(seen, d.muni)) {
      seen[d.muni] = { muni: d.muni, rows: [] };
      out.push(seen[d.muni]);
    }
    seen[d.muni].rows.push(d);
  });
  return out;
}
