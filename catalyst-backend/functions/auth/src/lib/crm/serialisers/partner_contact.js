'use strict';

/** A person acting for a partner. Deliberately not unique: one person may act
 *  for two orgs, so org_id is part of what identifies this relationship. */
module.exports = (d) => ({
  user_id: d.user_id || null,
  org_id: d.org_id || null,
  org_name: d.org_name || null,
  first_name: d.first_name || null,
  last_name: d.last_name || null,
  email: d.email || null,
  phone: d.phone || null,
  role: d.role || null,
  approval_status: d.approval_status || null,
});
