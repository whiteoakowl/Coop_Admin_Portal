/* global ZXing */
/* exported createKioskCameraScanner */
// Wraps @zxing/library (public/js/vendor/zxing.min.js) into the small
// start/stop interface the kiosk's "Mobile Barcode Scan" panels need -
// continuous, rear-camera barcode scanning right in the browser, no
// separate scanning app required. Every member barcode this app prints
// is CODE128 (public/js/name-tag-render-core.js's renderBarcodeEl, same
// default JsBarcode itself uses), so decoding is restricted to that one
// format for speed and to cut down on false reads.
//
// onDecode(text) fires once per distinct barcode - while the caller is
// still handling one decode (see busy() below) further frames are simply
// not reported, rather than firing again for the same badge still
// sitting in front of the camera. The caller is responsible for calling
// busy(true) immediately upon receiving a decode and busy(false) once
// it's ready for the next one (e.g. after its own "Checked In!" pause).
function createKioskCameraScanner(videoEl, onDecode, onError) {
  var reader = null;
  var isBusy = false;

  return {
    start: function () {
      if (typeof ZXing === 'undefined') {
        onError("Barcode scanning isn't supported in this browser.");
        return;
      }
      isBusy = false;
      var hints = new Map();
      hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.CODE_128]);
      reader = new ZXing.BrowserMultiFormatReader(hints);
      reader
        .decodeFromConstraints({ video: { facingMode: { ideal: 'environment' } } }, videoEl, function (result) {
          if (!result || isBusy) return;
          onDecode(result.getText());
        })
        .catch(function (err) {
          onError(
            err && err.name === 'NotAllowedError'
              ? 'Camera access was denied. Allow camera access to use Mobile Barcode Scan.'
              : 'Could not start the camera.'
          );
        });
    },
    stop: function () {
      if (reader) {
        reader.reset();
        reader = null;
      }
    },
    busy: function (value) {
      isBusy = value;
    },
  };
}
