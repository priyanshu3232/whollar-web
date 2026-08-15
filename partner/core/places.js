/* Where a partner may declare coverage: the city, then the region inside it.
 *
 * WHY A CONTROLLED LIST AT ALL. Coverage used to be a free-text box. A partner
 * could type "Scarberia" or "downtown-ish", the row wrote, and no cohort ever
 * matched it: the declared region IS the bid unit, and a bid unit nobody else
 * spells the same way is a bid unit that never fires.
 *
 * WHY THE REGION NAME IS THE WHOLE WIRE VALUE, and city and province are not
 * sent. routes/desk.js requireActiveCoverage() matches a bid against coverage
 * with slug(row.region) === slug(campaign.region), an EXACT match, server side,
 * on the region alone. So this list is only useful if a campaign's region is
 * drawn from the same list, and once it is, the region name carries all the
 * matching there is. Sending a composite like "Scarborough Centre, Toronto,
 * Ontario" would make every bid refuse. Whoever creates a campaigns row picks
 * its region from here.
 *
 * CITY AND PROVINCE ARE DERIVED, not stored. provider_coverage has no column
 * for either (create-tables.md section 16), so placeOf() below reads them back
 * out of this list. 250 of the 251 region names are unique, so that lookup is
 * exact for all but one: "West End" exists in both Toronto and Vancouver, and
 * the launch city wins, because it is the only one of the two running cohorts.
 * Adding city and province columns would make this exact; until then a wrong
 * answer is possible for exactly one name in a city we have not opened.
 *
 * LAUNCH. Six cities run cohorts. The rest render in the list, tagged Soon and
 * not selectable: a partner should see the ambition without declaring into a
 * market that has no cohorts, and the server would only write the row as
 * 'verifying' for an operator to reject by hand.
 *
 * SIZE OF A REGION. Roughly 25k to 40k households: uniform plant, big enough
 * that an incumbent repricing it hurts, small enough to stay coherent. That is
 * why Toronto splits into twenty and Oshawa stays whole. Municipal and
 * former-municipality names are official; the compass groupings inside them
 * (Scarborough East, North York Central) are ours.
 *
 * FSA IS NOT HERE, DELIBERATELY. Serviceability runs on FSA, so each region
 * will carry an FSA set as backend data. Exact FSA to region assignment has to
 * be validated against a Canada Post boundary file, and a fabricated list here
 * would be indistinguishable from a validated one.
 */

export var PLACES = [
  { city: "Brampton", province: "Ontario", launch: true,
    regions: ["Brampton Central", "Brampton East", "Brampton West"] },
  { city: "Markham", province: "Ontario", launch: true,
    regions: ["Markham Centre", "Markham North", "Markham South"] },
  { city: "Mississauga", province: "Ontario", launch: true,
    regions: ["Mississauga City Centre", "Mississauga Lakeshore", "Mississauga West", "Mississauga East", "Mississauga North"] },
  { city: "Richmond Hill", province: "Ontario", launch: true,
    regions: ["Richmond Hill South", "Richmond Hill North"] },
  { city: "Toronto", province: "Ontario", launch: true,
    regions: ["Scarborough Southwest", "Scarborough Centre", "Scarborough East", "Scarborough North", "North York West", "North York Central", "North York East", "North York South", "Etobicoke Lakeshore", "Etobicoke Centre", "Etobicoke North", "East York", "York", "Downtown Core", "Downtown East", "Downtown West", "Midtown", "The Annex", "West End", "East End"] },
  { city: "Vaughan", province: "Ontario", launch: true,
    regions: ["Vaughan Woodbridge", "Maple and VMC", "Thornhill Vaughan", "Kleinburg"] },
  { city: "Ajax", province: "Ontario", launch: false,
    regions: ["Ajax"] },
  { city: "Arnprior", province: "Ontario", launch: false,
    regions: ["Arnprior"] },
  { city: "Aurora", province: "Ontario", launch: false,
    regions: ["Aurora"] },
  { city: "Barrie", province: "Ontario", launch: false,
    regions: ["Barrie"] },
  { city: "Belleville", province: "Ontario", launch: false,
    regions: ["Belleville"] },
  { city: "Bracebridge", province: "Ontario", launch: false,
    regions: ["Bracebridge"] },
  { city: "Bradford", province: "Ontario", launch: false,
    regions: ["Bradford"] },
  { city: "Brant", province: "Ontario", launch: false,
    regions: ["Brant"] },
  { city: "Brantford", province: "Ontario", launch: false,
    regions: ["Brantford"] },
  { city: "Brockville", province: "Ontario", launch: false,
    regions: ["Brockville"] },
  { city: "Burlington", province: "Ontario", launch: false,
    regions: ["Burlington"] },
  { city: "Caledon", province: "Ontario", launch: false,
    regions: ["Caledon"] },
  { city: "Cambridge", province: "Ontario", launch: false,
    regions: ["Cambridge"] },
  { city: "Carleton Place", province: "Ontario", launch: false,
    regions: ["Carleton Place"] },
  { city: "Chatham-Kent", province: "Ontario", launch: false,
    regions: ["Chatham-Kent"] },
  { city: "Clarington", province: "Ontario", launch: false,
    regions: ["Clarington"] },
  { city: "Cobourg", province: "Ontario", launch: false,
    regions: ["Cobourg"] },
  { city: "Collingwood", province: "Ontario", launch: false,
    regions: ["Collingwood"] },
  { city: "Cornwall", province: "Ontario", launch: false,
    regions: ["Cornwall"] },
  { city: "East Gwillimbury", province: "Ontario", launch: false,
    regions: ["East Gwillimbury"] },
  { city: "Elliot Lake", province: "Ontario", launch: false,
    regions: ["Elliot Lake"] },
  { city: "Fort Erie", province: "Ontario", launch: false,
    regions: ["Fort Erie"] },
  { city: "Gananoque", province: "Ontario", launch: false,
    regions: ["Gananoque"] },
  { city: "Georgina", province: "Ontario", launch: false,
    regions: ["Georgina"] },
  { city: "Goderich", province: "Ontario", launch: false,
    regions: ["Goderich"] },
  { city: "Gravenhurst", province: "Ontario", launch: false,
    regions: ["Gravenhurst"] },
  { city: "Greater Sudbury", province: "Ontario", launch: false,
    regions: ["Greater Sudbury"] },
  { city: "Grimsby", province: "Ontario", launch: false,
    regions: ["Grimsby"] },
  { city: "Guelph", province: "Ontario", launch: false,
    regions: ["Guelph"] },
  { city: "Haldimand", province: "Ontario", launch: false,
    regions: ["Haldimand"] },
  { city: "Halton Hills", province: "Ontario", launch: false,
    regions: ["Halton Hills"] },
  { city: "Hamilton", province: "Ontario", launch: false,
    regions: ["Downtown Hamilton", "Hamilton East End", "Hamilton Mountain", "Stoney Creek", "Dundas", "Ancaster", "Flamborough", "Glanbrook"] },
  { city: "Huntsville", province: "Ontario", launch: false,
    regions: ["Huntsville"] },
  { city: "Ingersoll", province: "Ontario", launch: false,
    regions: ["Ingersoll"] },
  { city: "Innisfil", province: "Ontario", launch: false,
    regions: ["Innisfil"] },
  { city: "Kenora", province: "Ontario", launch: false,
    regions: ["Kenora"] },
  { city: "Kincardine", province: "Ontario", launch: false,
    regions: ["Kincardine"] },
  { city: "King City", province: "Ontario", launch: false,
    regions: ["King City"] },
  { city: "Kingston", province: "Ontario", launch: false,
    regions: ["Kingston"] },
  { city: "Kitchener", province: "Ontario", launch: false,
    regions: ["Kitchener"] },
  { city: "London", province: "Ontario", launch: false,
    regions: ["Downtown London", "North London", "East London", "South London", "West London"] },
  { city: "Midland", province: "Ontario", launch: false,
    regions: ["Midland"] },
  { city: "Milton", province: "Ontario", launch: false,
    regions: ["Milton"] },
  { city: "Newmarket", province: "Ontario", launch: false,
    regions: ["Newmarket"] },
  { city: "Niagara Falls", province: "Ontario", launch: false,
    regions: ["Niagara Falls"] },
  { city: "Niagara-on-the-Lake", province: "Ontario", launch: false,
    regions: ["Niagara-on-the-Lake"] },
  { city: "Norfolk", province: "Ontario", launch: false,
    regions: ["Norfolk"] },
  { city: "North Bay", province: "Ontario", launch: false,
    regions: ["North Bay"] },
  { city: "Oakville", province: "Ontario", launch: false,
    regions: ["Oakville"] },
  { city: "Orillia", province: "Ontario", launch: false,
    regions: ["Orillia"] },
  { city: "Oshawa", province: "Ontario", launch: false,
    regions: ["Oshawa"] },
  { city: "Ottawa", province: "Ontario", launch: false,
    regions: ["Downtown Ottawa", "Centretown", "Kanata", "Nepean", "Barrhaven", "Orleans", "Gloucester", "Vanier", "Stittsville", "Riverside South", "Alta Vista"] },
  { city: "Owen Sound", province: "Ontario", launch: false,
    regions: ["Owen Sound"] },
  { city: "Parry Sound", province: "Ontario", launch: false,
    regions: ["Parry Sound"] },
  { city: "Pembroke", province: "Ontario", launch: false,
    regions: ["Pembroke"] },
  { city: "Perth", province: "Ontario", launch: false,
    regions: ["Perth"] },
  { city: "Petawawa", province: "Ontario", launch: false,
    regions: ["Petawawa"] },
  { city: "Peterborough", province: "Ontario", launch: false,
    regions: ["Peterborough"] },
  { city: "Pickering", province: "Ontario", launch: false,
    regions: ["Pickering"] },
  { city: "Port Hope", province: "Ontario", launch: false,
    regions: ["Port Hope"] },
  { city: "Quinte West", province: "Ontario", launch: false,
    regions: ["Quinte West"] },
  { city: "Renfrew", province: "Ontario", launch: false,
    regions: ["Renfrew"] },
  { city: "Sarnia", province: "Ontario", launch: false,
    regions: ["Sarnia"] },
  { city: "Sault Ste. Marie", province: "Ontario", launch: false,
    regions: ["Sault Ste. Marie"] },
  { city: "Simcoe", province: "Ontario", launch: false,
    regions: ["Simcoe"] },
  { city: "Smiths Falls", province: "Ontario", launch: false,
    regions: ["Smiths Falls"] },
  { city: "St. Catharines", province: "Ontario", launch: false,
    regions: ["St. Catharines"] },
  { city: "Stratford", province: "Ontario", launch: false,
    regions: ["Stratford"] },
  { city: "Thunder Bay", province: "Ontario", launch: false,
    regions: ["Thunder Bay"] },
  { city: "Tillsonburg", province: "Ontario", launch: false,
    regions: ["Tillsonburg"] },
  { city: "Timmins", province: "Ontario", launch: false,
    regions: ["Timmins"] },
  { city: "Walkerton", province: "Ontario", launch: false,
    regions: ["Walkerton"] },
  { city: "Wasaga Beach", province: "Ontario", launch: false,
    regions: ["Wasaga Beach"] },
  { city: "Waterloo", province: "Ontario", launch: false,
    regions: ["Waterloo"] },
  { city: "Welland", province: "Ontario", launch: false,
    regions: ["Welland"] },
  { city: "Whitby", province: "Ontario", launch: false,
    regions: ["Whitby"] },
  { city: "Whitchurch-Stouffville", province: "Ontario", launch: false,
    regions: ["Whitchurch-Stouffville"] },
  { city: "Windsor", province: "Ontario", launch: false,
    regions: ["Downtown Windsor", "East Windsor", "South Windsor", "Riverside", "Walkerville"] },
  { city: "Woodstock", province: "Ontario", launch: false,
    regions: ["Woodstock"] },
  { city: "Abbotsford", province: "British Columbia", launch: false,
    regions: ["Abbotsford West", "Abbotsford East", "Clearbrook"] },
  { city: "Agassiz", province: "British Columbia", launch: false,
    regions: ["Agassiz"] },
  { city: "Burnaby", province: "British Columbia", launch: false,
    regions: ["Metrotown", "Brentwood", "Lougheed", "Edmonds"] },
  { city: "Campbell River", province: "British Columbia", launch: false,
    regions: ["Campbell River"] },
  { city: "Castlegar", province: "British Columbia", launch: false,
    regions: ["Castlegar"] },
  { city: "Central Saanich", province: "British Columbia", launch: false,
    regions: ["Central Saanich"] },
  { city: "Chilliwack", province: "British Columbia", launch: false,
    regions: ["Chilliwack"] },
  { city: "Colwood", province: "British Columbia", launch: false,
    regions: ["Colwood"] },
  { city: "Comox", province: "British Columbia", launch: false,
    regions: ["Comox"] },
  { city: "Coquitlam", province: "British Columbia", launch: false,
    regions: ["Coquitlam"] },
  { city: "Courtenay", province: "British Columbia", launch: false,
    regions: ["Courtenay"] },
  { city: "Cranbrook", province: "British Columbia", launch: false,
    regions: ["Cranbrook"] },
  { city: "Dawson Creek", province: "British Columbia", launch: false,
    regions: ["Dawson Creek"] },
  { city: "Delta", province: "British Columbia", launch: false,
    regions: ["North Delta", "Ladner", "Tsawwassen"] },
  { city: "Duncan", province: "British Columbia", launch: false,
    regions: ["Duncan"] },
  { city: "Esquimalt", province: "British Columbia", launch: false,
    regions: ["Esquimalt"] },
  { city: "Fernie", province: "British Columbia", launch: false,
    regions: ["Fernie"] },
  { city: "Fort St. John", province: "British Columbia", launch: false,
    regions: ["Fort St. John"] },
  { city: "Gibsons", province: "British Columbia", launch: false,
    regions: ["Gibsons"] },
  { city: "Golden", province: "British Columbia", launch: false,
    regions: ["Golden"] },
  { city: "Hope", province: "British Columbia", launch: false,
    regions: ["Hope"] },
  { city: "Kamloops", province: "British Columbia", launch: false,
    regions: ["Kamloops"] },
  { city: "Kelowna", province: "British Columbia", launch: false,
    regions: ["Kelowna"] },
  { city: "Kent", province: "British Columbia", launch: false,
    regions: ["Kent"] },
  { city: "Kimberley", province: "British Columbia", launch: false,
    regions: ["Kimberley"] },
  { city: "Kitimat", province: "British Columbia", launch: false,
    regions: ["Kitimat"] },
  { city: "Ladysmith", province: "British Columbia", launch: false,
    regions: ["Ladysmith"] },
  { city: "Langford", province: "British Columbia", launch: false,
    regions: ["Langford"] },
  { city: "Langley City", province: "British Columbia", launch: false,
    regions: ["Langley City"] },
  { city: "Langley Township", province: "British Columbia", launch: false,
    regions: ["Langley Township"] },
  { city: "Maple Ridge", province: "British Columbia", launch: false,
    regions: ["Maple Ridge"] },
  { city: "Mission", province: "British Columbia", launch: false,
    regions: ["Mission"] },
  { city: "Nanaimo", province: "British Columbia", launch: false,
    regions: ["Nanaimo"] },
  { city: "Nelson", province: "British Columbia", launch: false,
    regions: ["Nelson"] },
  { city: "New Westminster", province: "British Columbia", launch: false,
    regions: ["New Westminster"] },
  { city: "North Saanich", province: "British Columbia", launch: false,
    regions: ["North Saanich"] },
  { city: "North Vancouver City", province: "British Columbia", launch: false,
    regions: ["North Vancouver City"] },
  { city: "North Vancouver District", province: "British Columbia", launch: false,
    regions: ["North Vancouver District"] },
  { city: "Oak Bay", province: "British Columbia", launch: false,
    regions: ["Oak Bay"] },
  { city: "Parksville", province: "British Columbia", launch: false,
    regions: ["Parksville"] },
  { city: "Pemberton", province: "British Columbia", launch: false,
    regions: ["Pemberton"] },
  { city: "Penticton", province: "British Columbia", launch: false,
    regions: ["Penticton"] },
  { city: "Pitt Meadows", province: "British Columbia", launch: false,
    regions: ["Pitt Meadows"] },
  { city: "Port Alberni", province: "British Columbia", launch: false,
    regions: ["Port Alberni"] },
  { city: "Port Coquitlam", province: "British Columbia", launch: false,
    regions: ["Port Coquitlam"] },
  { city: "Port Moody", province: "British Columbia", launch: false,
    regions: ["Port Moody"] },
  { city: "Powell River", province: "British Columbia", launch: false,
    regions: ["Powell River"] },
  { city: "Prince George", province: "British Columbia", launch: false,
    regions: ["Prince George"] },
  { city: "Prince Rupert", province: "British Columbia", launch: false,
    regions: ["Prince Rupert"] },
  { city: "Qualicum Beach", province: "British Columbia", launch: false,
    regions: ["Qualicum Beach"] },
  { city: "Quesnel", province: "British Columbia", launch: false,
    regions: ["Quesnel"] },
  { city: "Revelstoke", province: "British Columbia", launch: false,
    regions: ["Revelstoke"] },
  { city: "Richmond", province: "British Columbia", launch: false,
    regions: ["Richmond City Centre", "Steveston"] },
  { city: "Saanich", province: "British Columbia", launch: false,
    regions: ["Saanich"] },
  { city: "Salmon Arm", province: "British Columbia", launch: false,
    regions: ["Salmon Arm"] },
  { city: "Sechelt", province: "British Columbia", launch: false,
    regions: ["Sechelt"] },
  { city: "Sidney", province: "British Columbia", launch: false,
    regions: ["Sidney"] },
  { city: "Smithers", province: "British Columbia", launch: false,
    regions: ["Smithers"] },
  { city: "Sooke", province: "British Columbia", launch: false,
    regions: ["Sooke"] },
  { city: "Squamish", province: "British Columbia", launch: false,
    regions: ["Squamish"] },
  { city: "Surrey", province: "British Columbia", launch: false,
    regions: ["Surrey City Centre", "Guildford", "Fleetwood", "Newton", "Cloverdale", "South Surrey"] },
  { city: "Terrace", province: "British Columbia", launch: false,
    regions: ["Terrace"] },
  { city: "Trail", province: "British Columbia", launch: false,
    regions: ["Trail"] },
  { city: "Vancouver", province: "British Columbia", launch: false,
    regions: ["Arbutus-Ridge", "Downtown", "Dunbar-Southlands", "Fairview", "Grandview-Woodland", "Hastings-Sunrise", "Kensington-Cedar Cottage", "Kerrisdale", "Killarney", "Kitsilano", "Marpole", "Mount Pleasant", "Oakridge", "Renfrew-Collingwood", "Riley Park", "Shaughnessy", "South Cambie", "Strathcona", "Sunset", "Victoria-Fraserview", "West End", "West Point Grey"] },
  { city: "Vernon", province: "British Columbia", launch: false,
    regions: ["Vernon"] },
  { city: "Victoria", province: "British Columbia", launch: false,
    regions: ["Downtown Victoria", "James Bay", "Fairfield", "Fernwood", "Vic West", "Rockland"] },
  { city: "View Royal", province: "British Columbia", launch: false,
    regions: ["View Royal"] },
  { city: "West Kelowna", province: "British Columbia", launch: false,
    regions: ["West Kelowna"] },
  { city: "West Vancouver", province: "British Columbia", launch: false,
    regions: ["West Vancouver"] },
  { city: "Whistler", province: "British Columbia", launch: false,
    regions: ["Whistler"] },
  { city: "White Rock", province: "British Columbia", launch: false,
    regions: ["White Rock"] },
  { city: "Williams Lake", province: "British Columbia", launch: false,
    regions: ["Williams Lake"] }
];

function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

/** The key a city option carries, since a city name alone is not unique. */
export function cityKey(city, province) { return city + '|' + province; }

export function findCity(city, province) {
  for (var i = 0; i < PLACES.length; i++) {
    if (PLACES[i].city === city && PLACES[i].province === province) return PLACES[i];
  }
  return null;
}

/** A city with no sub-regions declares as itself, and the picker says so. */
export function isWholeCity(p) {
  return !!(p && p.regions.length === 1 && p.regions[0] === p.city);
}

/**
 * The city a region belongs to, preferring a launch city on the one collision.
 * Used to read city and province back for a stored row, which carries neither.
 */
export function placeOf(region) {
  var k = norm(region), hit = null;
  for (var i = 0; i < PLACES.length; i++) {
    var p = PLACES[i];
    for (var j = 0; j < p.regions.length; j++) {
      if (norm(p.regions[j]) !== k) continue;
      if (p.launch) return p;
      if (!hit) hit = p;
    }
  }
  return hit;
}

/** "Scarborough Centre, Toronto, Ontario", or just the region if unplaced. */
export function readsAs(region) {
  var p = placeOf(region);
  return p ? region + ', ' + p.city + ', ' + p.province : region;
}

/** Is this region name one we run cohorts in? Declare refuses anything else. */
export function isLaunchRegion(region) {
  var p = placeOf(region);
  return !!(p && p.launch);
}

/** Cities matching a query, in list order, grouped by province downstream. */
export function searchCities(q) {
  var k = norm(q);
  if (!k) return PLACES.slice();
  return PLACES.filter(function (p) {
    return norm(p.city).indexOf(k) > -1 || norm(p.province).indexOf(k) > -1;
  });
}
