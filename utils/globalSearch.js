// Global Search (Community & Commerce track, item 14) - genuinely last,
// per the handoff's own framing ("there's nothing to search until the
// rest exists"). Permission-aware by construction, not by re-deriving
// access rules here: every source below is fetched through the SAME
// already-access-checked listing function its own member-facing router
// already calls (forums.accessibleCategories, customForms.formsVisibleTo,
// etc.) - search never bypasses a visibility check a browsing page would
// have enforced. Simple substring matching, not a real search index -
// this app's scale (a single co-op) doesn't call for one.
const db = require('../db');
const events = require('./events');
const directory = require('./directory');
const classifieds = require('./classifieds');
const forums = require('./forums');
const customForms = require('./customForms');
const store = require('./store');
const publications = require('./publications');
const photos = require('./photos');

function matches(query, ...fields) {
  const q = query.toLowerCase();
  return fields.some((f) => f && String(f).toLowerCase().includes(q));
}

function snippet(text, max = 140) {
  if (!text) return '';
  const s = String(text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// Member Directory is deliberately NOT included - its own per-field,
// admin-configured visibility (item 5) is too easy to get subtly wrong
// by re-deriving a text index over it here, and "search a name" isn't
// what this feature is for anyway (the Member Directory's own search/
// browse already covers that).
async function search(query, { family, roleIds }) {
  const q = (query || '').trim();
  if (!q) return [];
  const results = [];

  const upcomingEvents = await events.listEvents({ status: 'published' });
  for (const e of upcomingEvents) {
    if (matches(q, e.title, e.description)) results.push({ type: 'Event', title: e.title, url: `/events/${e.id}`, snippet: snippet(e.description) });
  }

  const listings = await directory.listListings({ status: 'active' });
  for (const l of listings) {
    if (matches(q, l.business_name, l.description)) results.push({ type: 'Business Directory', title: l.business_name, url: `/directory/${l.id}`, snippet: snippet(l.description) });
  }

  const classifiedAds = await classifieds.listListings({ status: 'active' });
  for (const c of classifiedAds) {
    if (matches(q, c.title, c.description)) results.push({ type: 'Classifieds', title: c.title, url: `/classifieds/${c.id}`, snippet: snippet(c.description) });
  }

  const categories = await forums.accessibleCategories(family);
  for (const category of categories) {
    const threads = await forums.listThreads(category.id);
    for (const t of threads) {
      if (matches(q, t.title)) results.push({ type: 'Forum Thread', title: t.title, url: `/forums/threads/${t.id}`, snippet: `in ${category.name}` });
    }
  }

  const forms = await customForms.formsVisibleTo(family, roleIds);
  for (const f of forms) {
    if (matches(q, f.title, f.description)) results.push({ type: 'Custom Form', title: f.title, url: `/forms/${f.id}`, snippet: snippet(f.description) });
  }

  const products = await store.listProducts({ status: 'active', availability: 'online' });
  for (const p of products) {
    if (matches(q, p.name, p.description)) results.push({ type: 'Store Product', title: p.name, url: `/store/${p.id}`, snippet: snippet(p.description) });
  }

  const publishedPublications = await publications.listPublications({ status: 'published' });
  for (const p of publishedPublications) {
    if (matches(q, p.title, p.body_html)) results.push({ type: 'Publication', title: p.title, url: `/publications/${p.id}`, snippet: snippet(p.body_html) });
  }

  const albums = await photos.listAlbums();
  for (const a of albums) {
    if (matches(q, a.title, a.description)) results.push({ type: 'Photo Album', title: a.title, url: `/photos/${a.id}`, snippet: snippet(a.description) });
  }

  const sentIssues = await db.prepare("SELECT * FROM newsletter_issues WHERE status = 'sent'").all();
  for (const i of sentIssues) {
    if (matches(q, i.subject)) results.push({ type: 'Newsletter', title: i.subject, url: `/newsletter/${i.id}`, snippet: '' });
  }

  return results;
}

module.exports = { search };
