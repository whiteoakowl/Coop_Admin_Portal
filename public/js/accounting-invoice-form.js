// New/Edit Invoice form (views/admin-accounting-invoice-form.ejs) - a real
// request (the reference screenshot): "+ Split Invoice" adds one or more
// extra description/amount line items, all billed to the same family
// alongside the form's own primary Description/Amount fields - the route
// (routes/admin-accounting.js's own splitLineItems) creates one charge
// per line item.
(function () {
  if (window.__accountingInvoiceSplitInstalled) return;
  window.__accountingInvoiceSplitInstalled = true;

  document.querySelectorAll('[data-split-invoice-form]').forEach((form) => {
    const addBtn = form.querySelector('[data-split-invoice-add]');
    const rows = form.querySelector('[data-split-invoice-rows]');
    const template = document.querySelector('[data-split-invoice-template]');
    if (!addBtn || !rows || !template) return;

    addBtn.addEventListener('click', () => {
      const row = template.content.firstElementChild.cloneNode(true);
      row.querySelector('[data-split-invoice-remove]').addEventListener('click', () => row.remove());
      rows.appendChild(row);
    });
  });
})();
