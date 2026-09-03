// Single source of truth for turning a badge layout ({ background,
// backgroundOpacity, elements }) into markup. Used by BOTH the design
// editor canvas (browser, builds innerHTML) and the print routes (Node,
// builds the same HTML string server-side via require()) so what you
// design is guaranteed to be exactly what prints - no separate
// hand-duplicated rendering path to keep in sync.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NameTagRenderCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VALIGN_FLEX = { top: 'flex-start', middle: 'center', bottom: 'flex-end' };

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function num(n, fallback) {
    return typeof n === 'number' && !isNaN(n) ? n : fallback;
  }

  function hexToRgb(hex) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (!m) return { r: 255, g: 255, b: 255 };
    return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
  }

  // Turns { background, backgroundOpacity } into a CSS background-color -
  // opacity 0 renders fully transparent (the editor's checkerboard shows
  // through), used both for the live canvas and the printed badge.
  function backgroundCss(background, backgroundOpacity) {
    var opacity = backgroundOpacity == null ? 1 : backgroundOpacity;
    if (opacity >= 1) return background || '#ffffff';
    var rgb = hexToRgb(background || '#ffffff');
    return 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + opacity + ')';
  }

  function elementBaseStyle(el) {
    var rotation = num(el.rotation, 0);
    var opacity = el.opacity == null ? 1 : el.opacity;
    var style =
      'left:' + el.x + 'px; top:' + el.y + 'px; width:' + el.width + 'px; height:' + el.height + 'px; opacity:' + opacity + ';';
    if (rotation) style += ' transform: rotate(' + rotation + 'deg);';
    return style;
  }

  function pointsToStr(points) {
    return points.map(function (p) { return p[0].toFixed(2) + ',' + p[1].toFixed(2); }).join(' ');
  }

  function starPoints(w, h) {
    var cx = w / 2, cy = h / 2, outerR = Math.min(w, h) / 2, innerR = outerR * 0.382;
    var pts = [];
    for (var i = 0; i < 10; i++) {
      var r = i % 2 === 0 ? outerR : innerR;
      var angle = (Math.PI / 5) * i - Math.PI / 2;
      pts.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
    }
    return pointsToStr(pts);
  }

  function regularPolygonPoints(w, h, sides) {
    var cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2;
    var pts = [];
    for (var i = 0; i < sides; i++) {
      var angle = ((2 * Math.PI) / sides) * i - Math.PI / 2;
      pts.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
    }
    return pointsToStr(pts);
  }

  function arrowPoints(w, h) {
    var shaftTop = h * 0.3, shaftBottom = h * 0.7, headW = Math.min(w * 0.4, h);
    return pointsToStr([
      [0, shaftTop], [w - headW, shaftTop], [w - headW, 0],
      [w, h / 2], [w - headW, h], [w - headW, shaftBottom], [0, shaftBottom],
    ]);
  }

  function dashArrayFor(dash, borderWidth) {
    var bw = borderWidth || 2;
    if (dash === 'dashed') return 'stroke-dasharray="' + Math.max(6, bw * 3) + ' ' + Math.max(4, bw * 2) + '"';
    if (dash === 'dotted') return 'stroke-dasharray="' + Math.max(2, bw) + ' ' + Math.max(4, bw * 2) + '"';
    return '';
  }

  // Given a shape element's true width/height, returns the inner SVG markup
  // (rect/ellipse/polygon/line) for its shapeType. Falls back to inferring
  // a type from old-format saved shapes that predate the shapeType field
  // (a circle used to be borderRadius:999, a line used to be height:4).
  function shapeMarkup(el) {
    var w = el.width, h = el.height;
    var shapeType = el.shapeType || (el.borderRadius >= 999 ? 'circle' : h <= 6 ? 'line' : 'rectangle');
    var borderWidth = num(el.borderWidth, 0);
    var fill = el.fill && el.fill !== 'transparent' ? el.fill : 'none';
    var fillAttr = 'fill="' + esc(fill) + '"';
    var strokeAttr = borderWidth > 0 ? 'stroke="' + esc(el.borderColor || '#1c2530') + '" stroke-width="' + borderWidth + '"' : 'stroke="none"';
    var dashAttr = dashArrayFor(el.dash, borderWidth);
    var inset = borderWidth / 2;

    switch (shapeType) {
      case 'roundedRect':
        return '<rect x="' + inset + '" y="' + inset + '" width="' + Math.max(0, w - borderWidth) + '" height="' + Math.max(0, h - borderWidth) + '" rx="' + num(el.borderRadius, 14) + '" ' + fillAttr + ' ' + strokeAttr + ' ' + dashAttr + '/>';
      case 'circle':
      case 'ellipse':
        return '<ellipse cx="' + w / 2 + '" cy="' + h / 2 + '" rx="' + Math.max(0, w / 2 - inset) + '" ry="' + Math.max(0, h / 2 - inset) + '" ' + fillAttr + ' ' + strokeAttr + ' ' + dashAttr + '/>';
      case 'triangle':
        return '<polygon points="' + pointsToStr([[w / 2, inset], [w - inset, h - inset], [inset, h - inset]]) + '" ' + fillAttr + ' ' + strokeAttr + ' ' + dashAttr + '/>';
      case 'diamond':
        return '<polygon points="' + pointsToStr([[w / 2, inset], [w - inset, h / 2], [w / 2, h - inset], [inset, h / 2]]) + '" ' + fillAttr + ' ' + strokeAttr + ' ' + dashAttr + '/>';
      case 'star':
        return '<polygon points="' + starPoints(w, h) + '" ' + fillAttr + ' ' + strokeAttr + ' ' + dashAttr + '/>';
      case 'polygon':
        return '<polygon points="' + regularPolygonPoints(w, h, 6) + '" ' + fillAttr + ' ' + strokeAttr + ' ' + dashAttr + '/>';
      case 'arrow':
        return '<polygon points="' + arrowPoints(w, h) + '" ' + fillAttr + ' ' + strokeAttr + ' ' + dashAttr + '/>';
      case 'line':
        return '<line x1="0" y1="' + h / 2 + '" x2="' + w + '" y2="' + h / 2 + '" stroke="' + esc(fill !== 'none' ? fill : el.borderColor || '#1c2530') + '" stroke-width="' + (borderWidth || h || 4) + '" stroke-linecap="round" ' + dashAttr + '/>';
      case 'rectangle':
      default:
        return '<rect x="' + inset + '" y="' + inset + '" width="' + Math.max(0, w - borderWidth) + '" height="' + Math.max(0, h - borderWidth) + '" ' + fillAttr + ' ' + strokeAttr + ' ' + dashAttr + '/>';
    }
  }

  // Rough "does this text fit on one line at this font size" estimate -
  // there's no real text-measurement API available in both the browser
  // editor AND the Node print route this same module runs in, so this
  // approximates each character as a fraction of the font size (wider
  // for bold) rather than laying it out for real. Good enough to catch
  // "Alexandria Montgomery-Whitfield" overflowing a name tag sized for
  // "Sam Lee" and scale it back down for the FIRST paint; exact kerning
  // isn't the point, because it isn't the last word either - a real
  // browser's actual glyph widths (and whichever webfont is actually
  // loaded - see public/js/badge-autofit.js's own comment) can still
  // disagree with this estimate, and disagreeing in the "should have
  // shrunk more" direction is exactly the failure a real bug report hit:
  // a name tag that looked fine in this estimate still wrapped onto a
  // second line and got clipped by the box's fixed height. So this is
  // only ever the STARTING guess; renderTextEl below forces autoFitText
  // onto a single line (no wrap to clip) and badge-autofit.js's real
  // browser measurement corrects the font size further down if this
  // estimate still wasn't small enough - the two together are what
  // actually guarantee "always fits," not this function alone.
  var AVG_CHAR_WIDTH_RATIO = { regular: 0.56, bold: 0.62 };
  var MIN_FONT_SIZE_RATIO = 0.55;

  function fitFontSize(text, el) {
    var baseFontSize = num(el.fontSize, 14);
    if (!text) return baseFontSize;
    var ratio = el.bold ? AVG_CHAR_WIDTH_RATIO.bold : AVG_CHAR_WIDTH_RATIO.regular;
    var available = Math.max(10, num(el.width, 100) - 6);
    var estimated = text.length * baseFontSize * ratio + text.length * num(el.letterSpacing, 0);
    if (estimated <= available) return baseFontSize;
    var scaled = baseFontSize * (available / estimated);
    var minFontSize = Math.max(7, baseFontSize * MIN_FONT_SIZE_RATIO);
    return Math.max(minFontSize, Math.round(scaled * 10) / 10);
  }

  // A bound field's value is normally a plain string (one line). The one
  // exception is a field like setupCleanupDays (utils/nameTagData.js's
  // setupCleanupJobLabels) that hands back an ARRAY of lines - a real
  // request: a parent's Monday and Wednesday setup/cleanup jobs should
  // "share a text space" (one shared element/box) instead of sitting as
  // two separately-positioned elements, while still reading as two
  // distinct, individually labeled lines rather than being smashed onto
  // one. renderTextEl below treats every field uniformly as "however many
  // lines it hands back" (1 for everything else, 2 here) rather than
  // having a separate code path just for this one field.
  function textLines(el, data) {
    var value = el.field === 'custom' ? (el.text || '') : (data && data[el.field]);
    if (Array.isArray(value)) return value.length ? value : [''];
    return [value || ''];
  }

  function renderTextEl(el, data) {
    var lines = textLines(el, data);
    var multiline = lines.length > 1;
    var valign = VALIGN_FLEX[el.valign] || 'center';
    var align = el.align || 'center';
    var deco = [];
    if (el.underline) deco.push('underline');
    if (el.strikethrough) deco.push('line-through');
    var fontFamily = el.fontFamily ? "'" + String(el.fontFamily).replace(/'/g, '') + "', sans-serif" : 'inherit';
    // A single-line field centers itself vertically within the box
    // (align-items on the flex row); a multi-line field instead stacks
    // its lines top-to-bottom (flex-direction:column) and centers/aligns
    // that whole stack, same valign meaning either way. A real request
    // (admin name tags with two stacked position titles): the stacked
    // lines should read as visually distinct entries "with a space
    // between," not touching - a small fixed gap rather than something
    // font-size-relative, since public/js/badge-autofit.js's own height
    // correction already measures box.scrollHeight (which includes this
    // gap) as ground truth and shrinks further if the gap ever pushes a
    // tight box past its own height, so a fixed value can't cause an
    // otherwise-avoidable clip.
    var style = elementBaseStyle(el) + ' display:flex; font-family:' + fontFamily + ';' +
      (multiline ? ' flex-direction:column; justify-content:' + valign + '; gap:4px;' : ' align-items:' + valign + ';');
    // A real request: "can we not update the template so these features
    // of wrap text and shrink to fit will always work no matter what we
    // create?" - autoFitText/autoFitWrap used to be per-element flags
    // that had to be explicitly set (by hand, or by a one-time DB
    // backfill) on every saved template - which is exactly why this kept
    // recurring: a template saved before a flag existed, or a field
    // nobody remembered to flag, silently clipped instead of shrinking.
    // Every BOUND field (anything except the two exceptions below - see
    // FIELDS_BY_TYPE in utils/nameTagBadge.js for the full list per badge
    // type: name, adminPosition, gradeLevel, allergies, setupCleanupDays,
    // memberCode, ...) now always gets autofit+wrap, derived from what the
    // field IS rather than from data that can go stale - true for any
    // current field, and for any future one added to FIELDS_BY_TYPE with
    // zero extra work. Two fields keep the old opt-in toggle (see name-
    // tag-editor.js's "Auto-fit text" checkbox, which now only shows for
    // these) instead of being forced on:
    //   - 'custom' text - an admin's own typed label/caption on the
    //     canvas, not real member/badge data whose length varies member to
    //     member, so a deliberately fixed size is a genuinely different
    //     case from a data field.
    //   - 'description' (the Setup/Cleanup badge's Task text, and the
    //     Custom badge's own Description) - a real, EXPLICIT prior
    //     request: "do not reduce the font size to keep it all on one
    //     line... simply continue the task description on the next line
    //     below it" (test/routes-admin-misc-badges-print.test.js). Unlike
    //     every other field here, this one is genuinely long-form prose
    //     where shrinking to force a fit can land on illegibly tiny text -
    //     the deliberate choice for THIS field is "wrap at a fixed,
    //     readable size, let the box grow instead" over "always fits, at
    //     whatever size that takes."
    var isBoundField = el.field !== 'custom' && el.field !== 'description';
    var autoFit = isBoundField || !!el.autoFitText;
    // autoFitWrap: lets the line actually wrap instead of forcing
    // nowrap+ellipsis - the fix for a real bug report, live screenshot: a
    // long single Admin Position ("Community Service Coordinator")
    // wrapped onto 2-3 lines and got clipped at the box's own top edge,
    // because plain autoFitText alone forces a field onto ONE
    // ever-shrinking line (right for Name, wrong for a position title -
    // "the admin positions should never be more than two stacked text
    // lines" is a request for real wrap, not endless shrinking).
    //
    // A real regression this caused, the very next morning: this used to
    // read `isBoundField || ...`, forcing wrap onto EVERY bound field
    // including 'name' and 'gradeLevel' - directly contradicting this
    // comment's own "right for Name" reasoning two lines above. Both of
    // those fields' values (utils/nameTagData.js's splitNameLines/
    // gradeLevelLabel) are deliberately pre-split into short, single-word-
    // ish lines ("Alexandria" / "Montgomery-Whitfield", "3rd" / "Grade")
    // specifically so each line can grow into a BIGGER single-line font
    // (see splitNameLines's own comment) - wrap mode instead starts each
    // line at its full configured fontSize with NO width pre-shrink
    // (badge-autofit.js's shrinkToFit skips computeLineFontSize for a
    // wrap-mode box on purpose), relying entirely on the box's fixed
    // HEIGHT to notice an overflow and shrink back down. For a name/grade
    // box sized for exactly its normal 1-2 lines, a single long unbroken
    // word wrapping mid-word inflates the line count before any shrink
    // ever kicks in, and the result is worse, not better, than the old
    // "just shrink it, one line, no matter how small" behavior these two
    // fields were always designed around. Name and Grade Level are
    // excluded here for that reason - every OTHER bound field (adminPosition,
    // allergies, setupCleanupDays, memberCode, and any future field) keeps
    // the "always wrap" default, same "no matter what we create" reasoning
    // as above; a 'custom' caption with autoFitText on can still opt into
    // wrap via its own el.autoFitWrap. public/js/badge-autofit.js's real-
    // browser height correction (already proven for 2+ actual stacked
    // positions) is what keeps however many lines any of this wraps to
    // inside the box, shrinking the font until they fit.
    var NEVER_WRAP_FIELDS = { name: true, gradeLevel: true };
    var autoFitWrap = (isBoundField && !NEVER_WRAP_FIELDS[el.field]) || (autoFit && !!el.autoFitWrap);
    // autoFitText's whole point (outside of autoFitWrap) is "stay on one
    // line, never clip" - a wrapped second line would just get cut off by
    // this element's own overflow:hidden (see public/css/styles.css's
    // .badge-el-text) since the box height never grows to fit a wrap.
    // Forcing nowrap here turns "wraps then gets silently clipped" into
    // "browser measures it as still too wide" - the signal public/js/
    // badge-autofit.js's real measurement pass (see its own comment) needs
    // to correct fontSize further when this function's estimate above
    // wasn't small enough; text-overflow: ellipsis is the static fallback
    // if that JS doesn't run at all, same convention as the barcode-only
    // sheet's .barcode-cell-name (see barcode-print-shrink-name.js).
    var wrapStyle = autoFit && !autoFitWrap
      ? ' white-space: nowrap; overflow: hidden; text-overflow: ellipsis;'
      : ' overflow-wrap: break-word;';
    var spans = lines.map(function (lineText) {
      // fitFontSize's own estimate assumes a single line, so it isn't the
      // right starting guess for a field that's meant to wrap - starting
      // at the box's own configured fontSize and letting badge-autofit.js's
      // real height measurement shrink it from there (same as a plain,
      // non-autofit field's static size) is what actually lets it settle
      // on 2 full-width lines instead of estimating itself down to fit
      // one.
      var fontSize = autoFit && !autoFitWrap ? fitFontSize(lineText, el) : num(el.fontSize, 14);
      var spanStyle =
        'display:block; width:100%; font-size:' + fontSize + 'px; color:' + (el.color || '#1c2530') + ';' +
        ' font-weight:' + (el.bold ? 700 : 400) + ';' +
        ' font-style:' + (el.italic ? 'italic' : 'normal') + ';' +
        ' text-decoration:' + (deco.length ? deco.join(' ') : 'none') + ';' +
        ' letter-spacing:' + num(el.letterSpacing, 0) + 'px;' +
        ' line-height:' + num(el.lineHeight, 1.15) + ';' +
        ' text-align:' + align + ';' +
        ' text-transform:' + (el.textCase || 'none') + ';' +
        wrapStyle;
      // badge-autofit.js's real-measurement pass needs to know the
      // fontSize fitFontSize actually settled on for THIS line (its own
      // search starts from there, shrinking further only if still too
      // wide) - stamped per-span (not per-box) so a multi-line field's two
      // lines, which can each need a different amount of shrinking, are
      // corrected independently rather than sharing one value.
      var lineAttr = autoFit ? ' data-base-font-size="' + fontSize + '"' : '';
      return '<span class="badge-el-text-inner"' + lineAttr + ' style="' + spanStyle + '">' + esc(lineText) + '</span>';
    });
    // data-autofit="1" stays on the outer box (badge-autofit.js's own
    // document.querySelectorAll('[data-autofit="1"]') entry point finds
    // boxes, then shrinks every .badge-el-text-inner line inside - see
    // that file's own comment). data-autofit-wrap="1" tells that same
    // script to skip its normal per-line WIDTH shrink for this box (which
    // assumes a single line and would just shrink the text down to fit
    // ONE line's worth of width, defeating the point of letting it wrap)
    // and rely on its height correction alone.
    var autoFitAttr = autoFit ? ' data-autofit="1"' + (autoFitWrap ? ' data-autofit-wrap="1"' : '') : '';
    return '<div class="badge-el badge-el-text" data-id="' + esc(el.id) + '" data-type="text"' + autoFitAttr + ' style="' + style + '">' + spans.join('') + '</div>';
  }

  function renderShapeEl(el) {
    var shapeType = el.shapeType || (el.borderRadius >= 999 ? 'circle' : el.height <= 6 ? 'line' : 'rectangle');
    var style = elementBaseStyle(el);
    return (
      '<svg class="badge-el badge-el-shape" data-id="' + esc(el.id) + '" data-type="shape" data-shape-type="' + esc(shapeType) + '" style="' + style + '" viewBox="0 0 ' + el.width + ' ' + el.height + '" preserveAspectRatio="none">' +
      shapeMarkup(el) +
      '</svg>'
    );
  }

  function renderImageEl(el) {
    var style = elementBaseStyle(el) + ' overflow:hidden;';
    if (!el.src) return '<div class="badge-el badge-el-image" data-id="' + esc(el.id) + '" data-type="image" style="' + style + '"></div>';
    var inner;
    if (el.cropW && el.naturalWidth) {
      var scale = el.width / el.cropW;
      var imgW = el.naturalWidth * scale;
      var imgH = el.naturalHeight * scale;
      var offX = -(el.cropX || 0) * scale;
      var offY = -(el.cropY || 0) * scale;
      inner = '<img src="' + esc(el.src) + '" alt="" style="position:absolute; left:' + offX + 'px; top:' + offY + 'px; width:' + imgW + 'px; height:' + imgH + 'px; max-width:none; max-height:none;" />';
    } else {
      inner = '<img src="' + esc(el.src) + '" alt="" style="width:100%; height:100%; object-fit:contain;" />';
    }
    return '<div class="badge-el badge-el-image" data-id="' + esc(el.id) + '" data-type="image" style="' + style + '">' + inner + '</div>';
  }

  function renderBarcodeEl(el, data) {
    var style = elementBaseStyle(el);
    var value = (data && data.barcodeValue) || '';
    return '<svg class="badge-el badge-el-barcode" data-id="' + esc(el.id) + '" data-type="barcode" data-barcode-value="' + esc(value) + '" style="' + style + '"></svg>';
  }

  // Schedule Card-only element: a fixed 4-row Class/Time/Class Name/Room
  // table, bound (via el.field) to an array of up to 4 {time, className,
  // room} rows - always renders exactly 4 rows, blank ones show an em
  // dash, matching the schedule editor's "always 4 rows" convention.
  // The table itself is always exactly the card's own fixed box (never
  // changes size - width:100%/height:100% of el.width/el.height,
  // overflow:hidden as a last-resort guard), but the 4 columns split
  // that fixed width by how much room their actual content needs this
  // time (a short room number doesn't need as many px as a long class
  // name) rather than a one-size-fits-all percentage - see
  // tableColumnWidths below.
  var TABLE_MIN_COLUMN_PCT = [5, 12, 30, 10]; // #, Time, Class Name, Room - floor so no column vanishes

  function tableColumnWidths(headers, colValues) {
    var weights = headers.map(function (label, i) {
      var maxLen = label.length;
      colValues[i].forEach(function (v) { maxLen = Math.max(maxLen, String(v || '').length); });
      return Math.max(1, maxLen);
    });
    var total = weights.reduce(function (a, b) { return a + b; }, 0);
    var pct = weights.map(function (w) { return (w / total) * 100; });
    // Apply floors, then renormalize so everything still sums to 100 -
    // whatever a floor bump takes is pulled back proportionally from the
    // columns that were already above their floor.
    var floors = TABLE_MIN_COLUMN_PCT;
    var deficit = 0;
    pct = pct.map(function (p, i) {
      if (p < floors[i]) { deficit += floors[i] - p; return floors[i]; }
      return p;
    });
    if (deficit > 0) {
      var aboveFloorTotal = 0;
      pct.forEach(function (p, i) { if (p > floors[i]) aboveFloorTotal += p - floors[i]; });
      if (aboveFloorTotal > 0) {
        pct = pct.map(function (p, i) {
          if (p <= floors[i]) return p;
          return p - deficit * ((p - floors[i]) / aboveFloorTotal);
        });
      }
    }
    var sum = pct.reduce(function (a, b) { return a + b; }, 0);
    return pct.map(function (p) { return (p / sum) * 100 + '%'; });
  }

  function renderTableEl(el, data) {
    var style = elementBaseStyle(el) + ' overflow:hidden;';
    var rows = (data && data[el.field]) || [];
    var fontSize = num(el.fontSize, 8);
    // A real request: "make the lines on the table of the schedule cards
    // black... make the font black." Neither is admin-configurable (the
    // table properties panel only ever offered Grid line color/Header
    // background - see schedule-card-editor.js), so the font color is
    // set unconditionally here rather than reading an el.color field that
    // doesn't exist; el.borderColor's own default only matters for a
    // template saved before the shared DEFAULT_LAYOUT default changed.
    var borderColor = el.borderColor || '#000000';
    var headerBg = el.headerColor || '#eaf4fd';
    var headers = ['#', 'Time', 'Class Name', 'Room'];
    var colValues = [
      [1, 2, 3, 4],
      [0, 1, 2, 3].map(function (i) { return (rows[i] || {}).time || '—'; }),
      [0, 1, 2, 3].map(function (i) { return (rows[i] || {}).className || '—'; }),
      [0, 1, 2, 3].map(function (i) { return (rows[i] || {}).room || '—'; }),
    ];
    var colWidths = tableColumnWidths(headers, colValues);
    function cellStyle(colIndex) {
      return 'width:' + colWidths[colIndex] + '; padding:1px 3px; border:1px solid ' + esc(borderColor) + '; font-size:' + fontSize + 'px; color:#000000; text-align:left; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;';
    }
    var html = '<table style="width:100%; height:100%; border-collapse:collapse; table-layout:fixed; font-family:inherit;"><thead><tr style="background:' + esc(headerBg) + ';">';
    headers.forEach(function (label, colIndex) {
      html += '<th style="' + cellStyle(colIndex) + '">' + esc(label) + '</th>';
    });
    html += '</tr></thead><tbody>';
    for (var i = 0; i < 4; i++) {
      var r = rows[i] || {};
      html +=
        '<tr><td style="' + cellStyle(0) + '">' + (i + 1) + '</td>' +
        '<td style="' + cellStyle(1) + '">' + esc(r.time || '—') + '</td>' +
        '<td style="' + cellStyle(2) + '">' + esc(r.className || '—') + '</td>' +
        '<td style="' + cellStyle(3) + '">' + esc(r.room || '—') + '</td></tr>';
    }
    html += '</tbody></table>';
    return '<div class="badge-el badge-el-table" data-id="' + esc(el.id) + '" data-type="table" style="' + style + '">' + html + '</div>';
  }

  function renderElement(el, data) {
    if (el.type === 'text') return renderTextEl(el, data);
    if (el.type === 'shape') return renderShapeEl(el);
    if (el.type === 'image') return renderImageEl(el);
    if (el.type === 'barcode') return renderBarcodeEl(el, data);
    if (el.type === 'table') return renderTableEl(el, data);
    return '';
  }

  // Renders every element in stacking (array) order - array order IS
  // z-order, front-most last - into one HTML string.
  function renderBadgeElements(elements, data) {
    return (elements || []).map(function (el) { return renderElement(el, data); }).join('');
  }

  return {
    renderElement: renderElement,
    renderBadgeElements: renderBadgeElements,
    backgroundCss: backgroundCss,
    shapeMarkup: shapeMarkup,
    esc: esc,
  };
});
