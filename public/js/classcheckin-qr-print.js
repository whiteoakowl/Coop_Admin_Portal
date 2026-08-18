// Renders a real, scannable QR code into every [data-qr-value] box on the
// Class Check-In QR print sheet (views/admin-classcheckin-qr-print.ejs) -
// client-side, same "server hands off the raw value, JS does the real
// rendering" split this app already uses for barcodes (public/js/vendor/
// jsbarcode.min.js + data-barcode-value). { scalable: true } drops the
// fixed pixel width/height jsbarcode's own SVG output has, so this one
// sizes purely off its viewBox and can be scaled by plain CSS to fit
// whatever box it lands in on the print sheet.
(function () {
  function renderAll() {
    document.querySelectorAll('[data-qr-value]').forEach(function (el) {
      if (el.dataset.qrRendered) return;
      var value = el.getAttribute('data-qr-value');
      if (!value) return;
      var qr = window.qrcode(0, 'M');
      qr.addData(value);
      qr.make();
      el.innerHTML = qr.createSvgTag({ scalable: true });
      el.dataset.qrRendered = '1';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderAll);
  } else {
    renderAll();
  }
})();
