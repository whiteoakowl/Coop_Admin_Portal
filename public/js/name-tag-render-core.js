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

  function renderTextEl(el, data) {
    var value = el.field === 'custom' ? esc(el.text || '') : esc((data && data[el.field]) || '');
    var valign = VALIGN_FLEX[el.valign] || 'center';
    var align = el.align || 'center';
    var deco = [];
    if (el.underline) deco.push('underline');
    if (el.strikethrough) deco.push('line-through');
    var fontFamily = el.fontFamily ? "'" + String(el.fontFamily).replace(/'/g, '') + "', sans-serif" : 'inherit';
    var style = elementBaseStyle(el) + ' display:flex; align-items:' + valign + '; font-family:' + fontFamily + ';';
    var spanStyle =
      'display:block; width:100%; font-size:' + num(el.fontSize, 14) + 'px; color:' + (el.color || '#1c2530') + ';' +
      ' font-weight:' + (el.bold ? 700 : 400) + ';' +
      ' font-style:' + (el.italic ? 'italic' : 'normal') + ';' +
      ' text-decoration:' + (deco.length ? deco.join(' ') : 'none') + ';' +
      ' letter-spacing:' + num(el.letterSpacing, 0) + 'px;' +
      ' line-height:' + num(el.lineHeight, 1.15) + ';' +
      ' text-align:' + align + ';' +
      ' text-transform:' + (el.textCase || 'none') + ';' +
      ' overflow-wrap: break-word;';
    return '<div class="badge-el badge-el-text" data-id="' + esc(el.id) + '" data-type="text" style="' + style + '"><span class="badge-el-text-inner" style="' + spanStyle + '">' + value + '</span></div>';
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

  function renderElement(el, data) {
    if (el.type === 'text') return renderTextEl(el, data);
    if (el.type === 'shape') return renderShapeEl(el);
    if (el.type === 'image') return renderImageEl(el);
    if (el.type === 'barcode') return renderBarcodeEl(el, data);
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
