/* global JsBarcode */
(function () {
  if (typeof JsBarcode === 'undefined') return;

  function renderBarcodes(root) {
    (root || document).querySelectorAll('.badge-el-barcode').forEach(function (svg) {
      var value = svg.dataset.barcodeValue;
      if (!value) return;
      try {
        JsBarcode(svg, value, {
          format: 'CODE128',
          displayValue: false,
          margin: 0,
          height: svg.clientHeight || 50,
        });
      } catch (e) {
        // Unrenderable value (e.g. empty placeholder) - leave the svg blank.
      }
    });
  }

  window.renderNameTagBarcodes = renderBarcodes;
  renderBarcodes(document);
})();
