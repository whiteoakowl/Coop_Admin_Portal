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
//
// A real bug report: "mobile barcode scan doesn't work on all mobile
// devices... make sure it works on all mobile devices no matter the age
// for all mobile check in types, attendance, class attendance, events
// etc." This one file backs every one of those (Class Check-In & Out,
// Find a Parent, Events Check-In, Orientation Check-In all create their
// own instance of it), so every hardening fix here applies everywhere
// the feature exists at once. Three real, concrete gaps fixed below -
// not guesses: (1) no check at all for a device/context that genuinely
// can't do camera access (old browser, or a kiosk reached over plain
// http:// instead of https:///localhost - getUserMedia requires a secure
// context), which used to either throw synchronously before this file's
// own .catch() could ever run, or surface the same generic "could not
// start the camera" as every other failure with no way for anyone
// on-site to tell those apart; (2) start() had no guard against being
// called a second time before a first call had finished starting (a
// double-tap, or a slow device replaying a click) - unlike desktop
// browsers, real mobile camera hardware/OS arbitration very often
// refuses a second concurrent stream request outright, failing the scan
// with nothing actually wrong with the barcode or lighting; (3) every
// getUserMedia failure reason (permission denied, no camera, camera
// already in use, unsupported constraints) collapsed into one generic
// message, leaving no way to tell a person on an unfamiliar device what
// to actually do about it.
function createKioskCameraScanner(videoEl, onDecode, onError) {
  var reader = null;
  var isBusy = false;

  function describeCameraError(err) {
    var name = err && err.name;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return 'Camera access was denied. Allow camera access to use Mobile Barcode Scan.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'No camera was found on this device. Use Barcode Scanner or Manually Enter ID# instead.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'The camera is already in use by another app or tab. Close it and try again, or use Barcode Scanner or Manually Enter ID# instead.';
    }
    if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
      return "This device's camera doesn't support the settings needed to scan. Use Barcode Scanner or Manually Enter ID# instead.";
    }
    return 'Could not start the camera. Use Barcode Scanner or Manually Enter ID# instead.';
  }

  function stop() {
    if (reader) {
      // A reader can still be mid-handshake (camera permission prompt
      // still up, stream not actually open yet) when stop() is called -
      // reset() on some browsers/versions throws in that exact window
      // instead of quietly no-oping. Never worth surfacing as a real
      // error: there's nothing left to tell the person using it, since
      // they're the one who just navigated away from this panel.
      try {
        reader.reset();
      } catch (err) {
        // intentionally ignored - see comment above.
      }
      reader = null;
    }
  }

  function start() {
    // Always fully stop any previous attempt first, so every start() is
    // a clean one regardless of how it got called twice - a double-tap,
    // a slow device replaying a click, or a caller re-entering this
    // panel before a prior start() finished. Without this, a 2nd
    // getUserMedia request could fire while the 1st camera stream was
    // still active; real mobile camera hardware very often refuses that
    // outright (reported as NotReadableError below) even though nothing
    // is actually wrong with the device's camera.
    stop();

    if (typeof ZXing === 'undefined') {
      onError("Barcode scanning isn't supported in this browser.");
      return;
    }
    // getUserMedia requires a secure context (https://, or localhost) -
    // on a kiosk reached over plain http:// on a local network (no TLS
    // cert), or a sufficiently old mobile browser, navigator.mediaDevices
    // is simply undefined rather than throwing a catchable error from
    // inside the library call below - checked explicitly here, with a
    // message that actually explains why, instead of the same generic
    // "could not start the camera" every other failure produces.
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      onError(
        window.isSecureContext === false
          ? 'Camera access needs a secure (https://) connection on this device. Use Barcode Scanner or Manually Enter ID# instead.'
          : "Camera scanning isn't supported on this device or browser. Use Barcode Scanner or Manually Enter ID# instead."
      );
      return;
    }

    try {
      isBusy = false;
      var hints = new Map();
      hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.CODE_128]);
      var thisReader = new ZXing.BrowserMultiFormatReader(hints);
      reader = thisReader;
      thisReader
        .decodeFromConstraints({ video: { facingMode: { ideal: 'environment' } } }, videoEl, function (result) {
          // A reader a later stop()/start() has already superseded can
          // still fire a queued decode callback on some devices after
          // reset() - reader !== thisReader catches that stale case, the
          // same "is this still the current attempt" check the .catch()
          // below also needs.
          if (!result || isBusy || reader !== thisReader) return;
          onDecode(result.getText());
        })
        .catch(function (err) {
          if (reader !== thisReader) return; // superseded by a later stop()/start() - nothing to report
          reader = null;
          onError(describeCameraError(err));
        });
    } catch (err) {
      // Belt-and-suspenders for a genuinely old/unusual mobile browser
      // whose camera/Promise/Map support is just different enough to
      // throw synchronously instead of rejecting a promise - without
      // this, that device's whole kiosk screen could silently break on
      // an uncaught exception here (nothing else is listening for one)
      // instead of just falling back to the other entry methods this
      // same page always offers alongside Mobile Barcode Scan.
      reader = null;
      onError('Could not start the camera on this device. Use Barcode Scanner or Manually Enter ID# instead.');
    }
  }

  return {
    start: start,
    stop: stop,
    busy: function (value) {
      isBusy = value;
    },
  };
}
