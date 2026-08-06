const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const requireFullAdmin = require('../middleware/requireFullAdmin');

router.use(requireFullAdmin);

const {
  findMemberByBarcode,
  findItemByBarcode,
  allItems,
  createItem,
  updateItem,
  deleteItem,
  activeCheckoutForItem,
  checkoutItems,
  returnCheckout,
  membersWithActiveCheckouts,
} = require('../utils/library');

const TABS = ['checkout', 'members', 'titles'];

router.get('/library', requireAdmin, (req, res) => {
  const tab = TABS.includes(req.query.tab) ? req.query.tab : 'checkout';
  res.render('admin-library', {
    title: 'Library',
    tab,
    items: allItems(),
    membersWithCheckouts: membersWithActiveCheckouts(),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// Checkout scan flow - AJAX lookups so the scan screen can build a pending
// list client-side before anything is actually saved.
router.post('/library/scan-member', requireAdmin, (req, res) => {
  const barcode = (req.body.barcode || '').trim();
  const member = barcode ? findMemberByBarcode(barcode) : null;
  if (!member) return res.json({ ok: false, message: 'No active member matches that barcode.' });
  res.json({ ok: true, member: { id: member.id, name: member.name } });
});

router.post('/library/scan-item', requireAdmin, (req, res) => {
  const barcode = (req.body.barcode || '').trim();
  const item = barcode ? findItemByBarcode(barcode) : null;
  if (!item) return res.json({ ok: false, message: 'No library item matches that barcode.' });
  const activeCheckout = activeCheckoutForItem(item.id);
  if (activeCheckout) {
    const holder = db.prepare('SELECT name FROM members WHERE id = ?').get(activeCheckout.member_id);
    return res.json({ ok: false, message: `"${item.title}" is already checked out to ${holder ? holder.name : 'someone'}.` });
  }
  res.json({ ok: true, item: { id: item.id, title: item.title } });
});

router.post('/library/checkout', requireAdmin, (req, res) => {
  const memberId = parseInt(req.body.memberId, 10);
  const itemIds = [].concat(req.body.itemIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
  const member = memberId ? db.prepare('SELECT * FROM members WHERE id = ?').get(memberId) : null;

  if (!member || itemIds.length === 0) {
    return res.redirect('/admin/library?error=' + encodeURIComponent('Scan a member and at least one item first.'));
  }

  checkoutItems(memberId, itemIds);
  res.redirect(
    '/admin/library?notice=' + encodeURIComponent(`Checked out ${itemIds.length} item(s) to ${member.name}.`)
  );
});

router.post('/library/checkouts/:id/return', requireAdmin, (req, res) => {
  returnCheckout(parseInt(req.params.id, 10));
  res.redirect('/admin/library?tab=members&notice=' + encodeURIComponent('Item marked returned.'));
});

// Titles catalog CRUD
router.post('/library/items/new', requireAdmin, (req, res) => {
  const title = (req.body.title || '').trim();
  const barcode = (req.body.barcode || '').trim();
  if (!title || !barcode) {
    return res.redirect('/admin/library?tab=titles&error=' + encodeURIComponent('Title and barcode are required.'));
  }
  if (findItemByBarcode(barcode)) {
    return res.redirect('/admin/library?tab=titles&error=' + encodeURIComponent('That barcode is already in use.'));
  }
  createItem(title, barcode);
  res.redirect('/admin/library?tab=titles&notice=' + encodeURIComponent(`"${title}" added.`));
});

router.post('/library/items/:id/edit', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const title = (req.body.title || '').trim();
  const barcode = (req.body.barcode || '').trim();
  if (title && barcode) updateItem(id, title, barcode);
  res.redirect('/admin/library?tab=titles');
});

router.post('/library/items/:id/delete', requireAdmin, (req, res) => {
  deleteItem(parseInt(req.params.id, 10));
  res.redirect('/admin/library?tab=titles&notice=' + encodeURIComponent('Item deleted.'));
});

module.exports = router;
