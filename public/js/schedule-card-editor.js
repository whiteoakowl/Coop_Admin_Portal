// Schedule Card design editor - the Schedule Card equivalent of
// name-tag-editor.js. Same drag/resize/rotate/undo-redo/properties-panel
// architecture and the same NameTagRenderCore rendering module, but a
// single shared layout (no per-member-type switching) and a "table" tool
// in place of "barcode" for the Class/Time/Class Name/Room grid.
(function () {
  const dataEl = document.getElementById('schedule-card-data');
  if (!dataEl) return;

  const Render = window.NameTagRenderCore;
  const seed = JSON.parse(dataEl.textContent);
  // Same basePath fallback pattern as name-tag-editor.js's own BASE_PATH -
  // lets this exact script be reused unmodified from Main Admin's own
  // Design/Print page (seed.basePath: '/main-admin/name-tags') instead of
  // Co-op Admin's (default '/admin/schedule', unchanged for every
  // existing caller that doesn't pass basePath at all).
  const BASE_PATH = seed.basePath || '/admin/schedule';
  const CARD_WIDTH = seed.cardWidth;
  const CARD_HEIGHT = seed.cardHeight;
  const FIELDS = seed.fields || [];
  const TABLE_FIELDS = seed.tableFields || [];
  const DEFAULT_LAYOUT = seed.defaultLayout;
  const SHAPE_TYPES = seed.shapeTypes || [];
  const FONT_FAMILIES = seed.fontFamilies || [];
  const GRID_SIZE = 8;
  const MIN_SIZE = 12;

  function cloneLayout(layout) {
    return JSON.parse(JSON.stringify(layout || {}));
  }

  // Caps a drag/resize/rotate callback to at most once per animation
  // frame - see name-tag-editor.js's own copy of this for why (a
  // touchscreen can fire pointermove far faster than the screen actually
  // repaints, and rebuilding the whole canvas on every one of those events
  // instead of once per frame is what made mobile dragging feel sluggish).
  function rafThrottle(fn) {
    let pending = false;
    return function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        fn();
      });
    };
  }

  // Working copy - edits happen here until "Save Template" persists them.
  let layout = cloneLayout(seed.template);

  const PLACEHOLDER_DATA = {
    name: 'Alex Student',
    // Matches utils/scheduleCardData.js's allergyLabel() format - a real
    // bug report: this field was missing here entirely, so the allergy
    // text element (see utils/scheduleCardBadge.js's DEFAULT_LAYOUT)
    // rendered with no text at all in the editor - its red (#dc2626)
    // color was visible on its properties panel swatch and its box still
    // occupied real canvas space, but with nothing inside to actually
    // see or select by clicking its text. The printed card was never
    // affected - utils/scheduleCardData.js's allergyLabel() computes the
    // real per-member value there, this object only feeds the editor's
    // own WYSIWYG preview.
    allergy: 'Allergies/Medical: Peanut allergy',
    primaryParentPhone: 'Parent Phone: (555) 123-4567',
    mondaySchedule: [
      { time: '9:00 - 9:45 AM', className: 'Math', room: 'Room 12' },
      { time: '10:00 - 10:45 AM', className: 'Science', room: 'Room 8' },
    ],
    wednesdaySchedule: [{ time: '9:00 - 9:45 AM', className: 'Art', room: 'Room 3' }],
  };

  let currentTool = '';
  let selectedId = null;
  let cropModeId = null;
  let idCounter = 1;
  let zoom = 1;
  let showGrid = false;
  let snapToGrid = false;

  const history = { stack: [cloneLayout(layout)], index: 0 };

  const canvas = document.getElementById('schedule-card-canvas');
  const zoomWrap = document.getElementById('schedule-card-canvas-zoom-wrap');
  const gridOverlay = document.getElementById('schedule-card-grid-overlay');
  const overlayLayer = document.getElementById('schedule-card-selection-overlay');
  const propsPanel = document.getElementById('schedule-card-properties');
  const toolIcons = document.getElementById('schedule-card-tool-icons');
  const toolPanel = document.getElementById('schedule-card-tool-panel');
  const saveStatus = document.getElementById('schedule-card-save-status');
  const undoBtn = document.getElementById('schedule-card-undo-btn');
  const redoBtn = document.getElementById('schedule-card-redo-btn');
  const zoomSelect = document.getElementById('schedule-card-zoom-select');
  const gridToggleBtn = document.getElementById('schedule-card-grid-toggle-btn');
  const snapToggleBtn = document.getElementById('schedule-card-snap-toggle-btn');

  function currentLayout() {
    return layout.elements;
  }

  function findEl(id) {
    return currentLayout().find((e) => e.id === id);
  }

  function newId(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + idCounter++;
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  // ---------- Undo/redo ----------
  function commitHistory() {
    history.stack = history.stack.slice(0, history.index + 1);
    history.stack.push(cloneLayout(layout));
    if (history.stack.length > 60) history.stack.shift();
    history.index = history.stack.length - 1;
    refreshHistoryButtons();
  }

  function undo() {
    if (history.index <= 0) return;
    history.index--;
    layout = cloneLayout(history.stack[history.index]);
    selectedId = null;
    cropModeId = null;
    renderCanvas();
    renderProperties();
    markUnsaved();
    refreshHistoryButtons();
  }

  function redo() {
    if (history.index >= history.stack.length - 1) return;
    history.index++;
    layout = cloneLayout(history.stack[history.index]);
    selectedId = null;
    cropModeId = null;
    renderCanvas();
    renderProperties();
    markUnsaved();
    refreshHistoryButtons();
  }

  function refreshHistoryButtons() {
    if (undoBtn) undoBtn.disabled = history.index <= 0;
    if (redoBtn) redoBtn.disabled = history.index >= history.stack.length - 1;
  }

  function markUnsaved() {
    saveStatus.textContent = 'Unsaved changes';
  }

  // ---------- Canvas rendering ----------
  function renderCanvas() {
    canvas.style.background = Render.backgroundCss(layout.background, layout.backgroundOpacity);
    canvas.innerHTML = Render.renderBadgeElements(layout.elements, PLACEHOLDER_DATA);

    canvas.querySelectorAll('.badge-el').forEach((node) => {
      const el = findEl(node.dataset.id);
      if (!el) return;
      if (el.locked) node.classList.add('badge-el-locked');
      node.addEventListener('pointerdown', (e) => startDrag(e, el));
      if (el.type === 'text' && el.field === 'custom') {
        const span = node.querySelector('.badge-el-text-inner');
        if (span) {
          span.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            startInlineEdit(el, span);
          });
        }
      }
    });

    renderSelectionOverlay();
    updateGridOverlay();
    // See public/js/name-tag-editor.js's identical call for why - keeps
    // the live design canvas matching what actually prints, not just what
    // the server's own character-width estimate predicted.
    if (window.runBadgeAutoFit) window.runBadgeAutoFit(canvas);
  }

  const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

  function renderSelectionOverlay() {
    if (!overlayLayer) return;
    overlayLayer.innerHTML = '';
    const el = findEl(selectedId);
    if (!el) return;
    const box = document.createElement('div');
    box.className = 'name-tag-selection-box' + (el.locked ? ' locked' : '');
    box.style.left = el.x * zoom + 'px';
    box.style.top = el.y * zoom + 'px';
    box.style.width = el.width * zoom + 'px';
    box.style.height = el.height * zoom + 'px';
    if (el.rotation) box.style.transform = 'rotate(' + el.rotation + 'deg)';
    overlayLayer.appendChild(box);
    if (el.locked) return;

    HANDLES.forEach((h) => {
      const handle = document.createElement('div');
      handle.className = 'name-tag-resize-handle name-tag-resize-handle-' + h;
      handle.addEventListener('pointerdown', (e) => startResize(e, el, h));
      box.appendChild(handle);
    });

    const stem = document.createElement('div');
    stem.className = 'name-tag-rotate-stem';
    box.appendChild(stem);
    const rotateHandle = document.createElement('div');
    rotateHandle.className = 'name-tag-rotate-handle';
    rotateHandle.setAttribute('title', 'Drag to rotate');
    rotateHandle.addEventListener('pointerdown', (e) => startRotate(e, el));
    box.appendChild(rotateHandle);
  }

  function updateGridOverlay() {
    if (!gridOverlay) return;
    gridOverlay.style.display = showGrid ? 'block' : 'none';
    gridOverlay.style.width = CARD_WIDTH * zoom + 'px';
    gridOverlay.style.height = CARD_HEIGHT * zoom + 'px';
    const size = GRID_SIZE * zoom;
    gridOverlay.style.backgroundSize = size + 'px ' + size + 'px';
  }

  function applyZoom() {
    canvas.style.transform = 'scale(' + zoom + ')';
    canvas.style.transformOrigin = 'top left';
    zoomWrap.style.width = CARD_WIDTH * zoom + 'px';
    zoomWrap.style.height = CARD_HEIGHT * zoom + 'px';
    renderCanvas();
  }

  // A real bug report: on a phone-width screen the canvas's fixed
  // CARD_WIDTH (336px) can be wider than the column it sits in, bleeding
  // off the edge of the mobile view - the Zoom dropdown already lets a
  // desktop user shrink it, this just picks a sane starting point
  // automatically instead of loading straight into a card that overflows
  // the screen. Runs once, at load only - a later reflow (rotating the
  // phone, say) doesn't fight whatever zoom the person has since chosen.
  // Mirrors public/js/name-tag-editor.js's own autoFitZoomToViewport.
  function autoFitZoomToViewport() {
    if (!zoomSelect || !zoomWrap.parentElement) return;
    const available = zoomWrap.parentElement.clientWidth;
    if (!available || available >= CARD_WIDTH) return;
    const options = Array.from(zoomSelect.options).map((o) => parseFloat(o.value)).filter((v) => !Number.isNaN(v));
    if (!options.length) return;
    const fits = options.filter((v) => CARD_WIDTH * v <= available);
    const best = fits.length ? Math.max(...fits) : Math.min(...options);
    if (best === zoom) return;
    zoomSelect.value = String(best);
    zoom = best;
    applyZoom();
  }

  // ---------- Move / resize / rotate ----------
  function startDrag(e, el) {
    if (el.locked) return;
    e.preventDefault();
    if (selectedId !== el.id) {
      selectedId = el.id;
      cropModeId = null;
      renderCanvas();
      renderProperties();
    }
    // Keeps this same gesture routed to the handler that started it even
    // if a finger drifts off the (often small) element it began on -
    // without this a touch drag can silently get reassigned mid-move.
    if (e.target.setPointerCapture) e.target.setPointerCapture(e.pointerId);

    const startX = e.clientX;
    const startY = e.clientY;
    const originX = el.x;
    const originY = el.y;
    let moved = false;
    const scheduleRender = rafThrottle(renderCanvas);

    function onMove(ev) {
      moved = true;
      const dx = (ev.clientX - startX) / zoom;
      const dy = (ev.clientY - startY) / zoom;
      let nx = originX + dx;
      let ny = originY + dy;
      if (snapToGrid) {
        nx = Math.round(nx / GRID_SIZE) * GRID_SIZE;
        ny = Math.round(ny / GRID_SIZE) * GRID_SIZE;
      }
      el.x = clamp(nx, 0, Math.max(0, CARD_WIDTH - el.width));
      el.y = clamp(ny, 0, Math.max(0, CARD_HEIGHT - el.height));
      scheduleRender();
    }
    function onUp() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (moved) {
        renderCanvas();
        markUnsaved();
        commitHistory();
        renderProperties();
      }
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  const HANDLE_ANCHOR = {
    nw: [1, 1], n: [0, 1], ne: [-1, 1], e: [-1, 0],
    se: [-1, -1], s: [0, -1], sw: [1, -1], w: [1, 0],
  };
  const HANDLE_DELTA = {
    nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0],
    se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0],
  };

  function startResize(e, el, handle) {
    if (el.locked) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.target.setPointerCapture) e.target.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const originW = el.width;
    const originH = el.height;
    const originX = el.x;
    const originY = el.y;
    const theta = ((el.rotation || 0) * Math.PI) / 180;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    const cx = originX + originW / 2;
    const cy = originY + originH / 2;
    const anchor = HANDLE_ANCHOR[handle];
    const delta = HANDLE_DELTA[handle];
    let moved = false;
    const scheduleRender = rafThrottle(renderCanvas);

    function onMove(ev) {
      moved = true;
      const dx = (ev.clientX - startX) / zoom;
      const dy = (ev.clientY - startY) / zoom;
      const localDx = dx * cosT + dy * sinT;
      const localDy = -dx * sinT + dy * cosT;

      let newW = Math.max(MIN_SIZE, originW + delta[0] * localDx);
      let newH = Math.max(MIN_SIZE, originH + delta[1] * localDy);
      if (snapToGrid) {
        newW = Math.max(MIN_SIZE, Math.round(newW / GRID_SIZE) * GRID_SIZE);
        newH = Math.max(MIN_SIZE, Math.round(newH / GRID_SIZE) * GRID_SIZE);
      }

      const anchorLocal = { x: anchor[0] * (originW / 2), y: anchor[1] * (originH / 2) };
      const anchorParent = {
        x: cx + anchorLocal.x * cosT - anchorLocal.y * sinT,
        y: cy + anchorLocal.x * sinT + anchorLocal.y * cosT,
      };
      const centerOffsetLocal = { x: -anchor[0] * (newW / 2), y: -anchor[1] * (newH / 2) };
      const newCenter = {
        x: anchorParent.x + centerOffsetLocal.x * cosT - centerOffsetLocal.y * sinT,
        y: anchorParent.y + centerOffsetLocal.x * sinT + centerOffsetLocal.y * cosT,
      };

      el.width = newW;
      el.height = newH;
      el.x = newCenter.x - newW / 2;
      el.y = newCenter.y - newH / 2;
      scheduleRender();
    }
    function onUp() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (moved) {
        renderCanvas();
        markUnsaved();
        commitHistory();
        renderProperties();
      }
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  function startRotate(e, el) {
    if (el.locked) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.target.setPointerCapture) e.target.setPointerCapture(e.pointerId);
    let moved = false;
    const scheduleRender = rafThrottle(renderCanvas);

    function onMove(ev) {
      moved = true;
      const canvasRect = canvas.getBoundingClientRect();
      const cx = canvasRect.left + (el.x + el.width / 2) * zoom;
      const cy = canvasRect.top + (el.y + el.height / 2) * zoom;
      const angle = Math.atan2(ev.clientY - cy, ev.clientX - cx);
      let deg = (angle * 180) / Math.PI + 90;
      deg = ((deg % 360) + 360) % 360;
      if (deg > 180) deg -= 360;
      if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
      el.rotation = Math.round(deg);
      scheduleRender();
    }
    function onUp() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (moved) {
        renderCanvas();
        markUnsaved();
        commitHistory();
        renderProperties();
      }
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  function startInlineEdit(el, span) {
    if (el.locked) return;
    span.contentEditable = 'true';
    span.focus();
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    function onKeydown(ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        span.blur();
      } else if (ev.key === 'Escape') {
        span.textContent = el.text || '';
        span.blur();
      }
    }
    function onBlur() {
      el.text = span.textContent;
      span.removeEventListener('blur', onBlur);
      span.removeEventListener('keydown', onKeydown);
      markUnsaved();
      commitHistory();
      renderCanvas();
      renderProperties();
    }
    span.addEventListener('blur', onBlur);
    span.addEventListener('keydown', onKeydown);
  }

  // ---------- Element actions ----------
  function duplicateElement(el) {
    const copy = JSON.parse(JSON.stringify(el));
    copy.id = newId(el.type);
    copy.locked = false;
    copy.x = clamp(el.x + 12, 0, Math.max(0, CARD_WIDTH - el.width));
    copy.y = clamp(el.y + 12, 0, Math.max(0, CARD_HEIGHT - el.height));
    currentLayout().push(copy);
    selectedId = copy.id;
    renderCanvas();
    markUnsaved();
    commitHistory();
    renderProperties();
  }

  function toggleLock(el) {
    el.locked = !el.locked;
    renderCanvas();
    markUnsaved();
    commitHistory();
    renderProperties();
  }

  function deleteElement(el) {
    const idx = currentLayout().findIndex((e) => e.id === el.id);
    if (idx >= 0) currentLayout().splice(idx, 1);
    selectedId = null;
    cropModeId = null;
    renderCanvas();
    renderProperties();
    markUnsaved();
    commitHistory();
  }

  function reorderElement(el, mode) {
    if (el.locked) return;
    const arr = currentLayout();
    const idx = arr.findIndex((e) => e.id === el.id);
    if (idx < 0) return;
    arr.splice(idx, 1);
    if (mode === 'front') arr.push(el);
    else if (mode === 'back') arr.unshift(el);
    else if (mode === 'forward') arr.splice(Math.min(arr.length, idx + 1), 0, el);
    else if (mode === 'backward') arr.splice(Math.max(0, idx - 1), 0, el);
    renderCanvas();
    markUnsaved();
    commitHistory();
    renderProperties();
  }

  function alignElement(el, mode) {
    if (el.locked) return;
    if (mode === 'left') el.x = 0;
    else if (mode === 'center-h') el.x = (CARD_WIDTH - el.width) / 2;
    else if (mode === 'right') el.x = CARD_WIDTH - el.width;
    else if (mode === 'top') el.y = 0;
    else if (mode === 'middle-v') el.y = (CARD_HEIGHT - el.height) / 2;
    else if (mode === 'bottom') el.y = CARD_HEIGHT - el.height;
    renderCanvas();
    markUnsaved();
    commitHistory();
    renderProperties();
  }

  // ---------- Properties panel ----------
  function propRow(labelText, inputEl) {
    const row = document.createElement('div');
    row.className = 'name-tag-prop-row';
    const label = document.createElement('label');
    label.textContent = labelText;
    row.appendChild(label);
    row.appendChild(inputEl);
    return row;
  }

  function propDivider() {
    const div = document.createElement('div');
    div.className = 'name-tag-prop-divider';
    return div;
  }

  function iconToggleBtn(iconHrefOrText, title, active, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'name-tag-mini-btn' + (active ? ' active' : '');
    btn.title = title;
    btn.setAttribute('aria-label', title);
    if (iconHrefOrText.charAt(0) === '#') {
      btn.innerHTML = '<svg class="icon"><use href="' + iconHrefOrText + '"/></svg>';
    } else {
      btn.textContent = iconHrefOrText;
    }
    btn.addEventListener('click', onClick);
    return btn;
  }

  function fieldLabel(field) {
    if (field === 'custom') return 'Custom Text';
    const found = FIELDS.find((f) => f.field === field) || TABLE_FIELDS.find((f) => f.field === field);
    return found ? found.label : null;
  }

  function renderBaseControls(el) {
    propsPanel.appendChild(propDivider());

    const opacity = document.createElement('input');
    opacity.type = 'range';
    opacity.min = '10';
    opacity.max = '100';
    opacity.step = '5';
    opacity.value = Math.round((el.opacity == null ? 1 : el.opacity) * 100);
    opacity.addEventListener('input', () => {
      el.opacity = parseInt(opacity.value, 10) / 100;
      renderCanvas();
    });
    opacity.addEventListener('change', () => {
      markUnsaved();
      commitHistory();
    });
    propsPanel.appendChild(propRow('Opacity', opacity));

    const rotation = document.createElement('input');
    rotation.type = 'number';
    rotation.min = '-180';
    rotation.max = '180';
    rotation.value = el.rotation || 0;
    rotation.addEventListener('input', () => {
      el.rotation = parseInt(rotation.value, 10) || 0;
      renderCanvas();
    });
    rotation.addEventListener('change', () => {
      markUnsaved();
      commitHistory();
    });
    propsPanel.appendChild(propRow('Rotation (°)', rotation));

    propsPanel.appendChild(propDivider());

    const layerLabel = document.createElement('p');
    layerLabel.className = 'name-tag-mini-label';
    layerLabel.textContent = 'Layer order';
    propsPanel.appendChild(layerLabel);
    const layerRow = document.createElement('div');
    layerRow.className = 'name-tag-mini-btn-row';
    layerRow.appendChild(iconToggleBtn('To Front', 'Bring to Front', false, () => reorderElement(el, 'front')));
    layerRow.appendChild(iconToggleBtn('Forward', 'Bring Forward', false, () => reorderElement(el, 'forward')));
    layerRow.appendChild(iconToggleBtn('Backward', 'Send Backward', false, () => reorderElement(el, 'backward')));
    layerRow.appendChild(iconToggleBtn('To Back', 'Send to Back', false, () => reorderElement(el, 'back')));
    propsPanel.appendChild(layerRow);

    const alignLabel = document.createElement('p');
    alignLabel.className = 'name-tag-mini-label';
    alignLabel.textContent = 'Align on card';
    propsPanel.appendChild(alignLabel);
    const alignRow1 = document.createElement('div');
    alignRow1.className = 'name-tag-mini-btn-row';
    alignRow1.appendChild(iconToggleBtn('Left', 'Align Left', false, () => alignElement(el, 'left')));
    alignRow1.appendChild(iconToggleBtn('Center', 'Align Center', false, () => alignElement(el, 'center-h')));
    alignRow1.appendChild(iconToggleBtn('Right', 'Align Right', false, () => alignElement(el, 'right')));
    propsPanel.appendChild(alignRow1);
    const alignRow2 = document.createElement('div');
    alignRow2.className = 'name-tag-mini-btn-row';
    alignRow2.appendChild(iconToggleBtn('Top', 'Align Top', false, () => alignElement(el, 'top')));
    alignRow2.appendChild(iconToggleBtn('Middle', 'Align Middle', false, () => alignElement(el, 'middle-v')));
    alignRow2.appendChild(iconToggleBtn('Bottom', 'Align Bottom', false, () => alignElement(el, 'bottom')));
    propsPanel.appendChild(alignRow2);

    propsPanel.appendChild(propDivider());

    const actionRow = document.createElement('div');
    actionRow.className = 'name-tag-mini-btn-row';
    actionRow.appendChild(iconToggleBtn('#icon-copy', 'Duplicate', false, () => duplicateElement(el)));
    actionRow.appendChild(iconToggleBtn(el.locked ? '#icon-unlock' : '#icon-lock', el.locked ? 'Unlock' : 'Lock', el.locked, () => toggleLock(el)));
    propsPanel.appendChild(actionRow);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn-secondary name-tag-delete-btn';
    deleteBtn.textContent = 'Delete Element';
    deleteBtn.addEventListener('click', () => deleteElement(el));
    propsPanel.appendChild(deleteBtn);
  }

  function renderTextProps(el) {
    if (el.field === 'custom') {
      const textArea = document.createElement('textarea');
      textArea.className = 'name-tag-text-area';
      textArea.value = el.text || '';
      textArea.rows = 2;
      textArea.addEventListener('input', () => {
        el.text = textArea.value;
        renderCanvas();
      });
      textArea.addEventListener('change', () => {
        markUnsaved();
        commitHistory();
      });
      propsPanel.appendChild(propRow('Text', textArea));
    }

    const fontFamily = document.createElement('select');
    FONT_FAMILIES.forEach((f) => {
      const opt = document.createElement('option');
      opt.value = f;
      opt.textContent = f;
      if ((el.fontFamily || FONT_FAMILIES[0]) === f) opt.selected = true;
      fontFamily.appendChild(opt);
    });
    fontFamily.addEventListener('change', () => {
      el.fontFamily = fontFamily.value;
      renderCanvas();
      markUnsaved();
      commitHistory();
    });
    propsPanel.appendChild(propRow('Font', fontFamily));

    const fontSize = document.createElement('input');
    fontSize.type = 'number';
    fontSize.min = '8';
    fontSize.max = '72';
    fontSize.value = el.fontSize;
    fontSize.addEventListener('input', () => {
      el.fontSize = parseInt(fontSize.value, 10) || 12;
      renderCanvas();
    });
    fontSize.addEventListener('change', () => {
      markUnsaved();
      commitHistory();
    });
    propsPanel.appendChild(propRow('Font size', fontSize));

    // A real request: "can we not update the template so these features
    // of wrap text and shrink to fit will always work no matter what we
    // create?" - every field except 'custom'/'description' now always
    // shrinks/wraps to fit regardless of this flag (see name-tag-render-
    // core.js's renderTextEl for both exceptions' own reasoning), so
    // showing this checkbox for one of those would be misleading - it'd
    // look toggleable but do nothing.
    if (el.field === 'custom' || el.field === 'description') {
      const autoFit = document.createElement('input');
      autoFit.type = 'checkbox';
      autoFit.checked = !!el.autoFitText;
      autoFit.addEventListener('change', () => {
        el.autoFitText = autoFit.checked;
        renderCanvas();
        markUnsaved();
        commitHistory();
      });
      propsPanel.appendChild(propRow('Auto-fit text', autoFit));
    }

    const color = document.createElement('input');
    color.type = 'color';
    color.value = el.color;
    color.addEventListener('input', () => {
      el.color = color.value;
      renderCanvas();
    });
    color.addEventListener('change', () => {
      markUnsaved();
      commitHistory();
    });
    propsPanel.appendChild(propRow('Color', color));

    const styleRow = document.createElement('div');
    styleRow.className = 'name-tag-mini-btn-row';
    styleRow.appendChild(iconToggleBtn('B', 'Bold', !!el.bold, () => { el.bold = !el.bold; renderCanvas(); markUnsaved(); commitHistory(); renderProperties(); }));
    styleRow.appendChild(iconToggleBtn('I', 'Italic', !!el.italic, () => { el.italic = !el.italic; renderCanvas(); markUnsaved(); commitHistory(); renderProperties(); }));
    styleRow.appendChild(iconToggleBtn('U', 'Underline', !!el.underline, () => { el.underline = !el.underline; renderCanvas(); markUnsaved(); commitHistory(); renderProperties(); }));
    styleRow.appendChild(iconToggleBtn('S', 'Strikethrough', !!el.strikethrough, () => { el.strikethrough = !el.strikethrough; renderCanvas(); markUnsaved(); commitHistory(); renderProperties(); }));
    propsPanel.appendChild(propRow('Style', styleRow));

    const alignLabel = document.createElement('p');
    alignLabel.className = 'name-tag-mini-label';
    alignLabel.textContent = 'Text align';
    propsPanel.appendChild(alignLabel);
    const alignRow = document.createElement('div');
    alignRow.className = 'name-tag-mini-btn-row';
    [['left', 'Left'], ['center', 'Center'], ['right', 'Right'], ['justify', 'Justify']].forEach(([val, lbl]) => {
      alignRow.appendChild(iconToggleBtn(lbl, 'Align ' + lbl, (el.align || 'center') === val, () => { el.align = val; renderCanvas(); markUnsaved(); commitHistory(); renderProperties(); }));
    });
    propsPanel.appendChild(alignRow);

    const valignLabel = document.createElement('p');
    valignLabel.className = 'name-tag-mini-label';
    valignLabel.textContent = 'Vertical align';
    propsPanel.appendChild(valignLabel);
    const valignRow = document.createElement('div');
    valignRow.className = 'name-tag-mini-btn-row';
    [['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']].forEach(([val, lbl]) => {
      valignRow.appendChild(iconToggleBtn(lbl, 'Vertical Align ' + lbl, (el.valign || 'middle') === val, () => { el.valign = val; renderCanvas(); markUnsaved(); commitHistory(); renderProperties(); }));
    });
    propsPanel.appendChild(valignRow);
  }

  function renderShapeProps(el) {
    const shapeType = el.shapeType || (el.borderRadius >= 999 ? 'circle' : el.height <= 6 ? 'line' : 'rectangle');
    const isLine = shapeType === 'line';

    if (!isLine) {
      const noFill = document.createElement('input');
      noFill.type = 'checkbox';
      noFill.checked = !el.fill || el.fill === 'transparent';

      const fill = document.createElement('input');
      fill.type = 'color';
      fill.value = el.fill && el.fill !== 'transparent' ? el.fill : '#ffffff';
      fill.disabled = noFill.checked;
      fill.addEventListener('input', () => {
        el.fill = fill.value;
        renderCanvas();
      });
      fill.addEventListener('change', () => {
        markUnsaved();
        commitHistory();
      });
      noFill.addEventListener('change', () => {
        fill.disabled = noFill.checked;
        el.fill = noFill.checked ? 'transparent' : fill.value;
        renderCanvas();
        markUnsaved();
        commitHistory();
      });
      propsPanel.appendChild(propRow('No fill', noFill));
      propsPanel.appendChild(propRow('Fill color', fill));
    }

    const borderColor = document.createElement('input');
    borderColor.type = 'color';
    borderColor.value = el.borderColor && el.borderColor !== 'transparent' ? el.borderColor : '#000000';
    borderColor.addEventListener('input', () => {
      el.borderColor = borderColor.value;
      renderCanvas();
    });
    borderColor.addEventListener('change', () => {
      markUnsaved();
      commitHistory();
    });

    const borderWidth = document.createElement('input');
    borderWidth.type = 'number';
    borderWidth.min = '0';
    borderWidth.max = '20';
    borderWidth.value = el.borderWidth || 0;
    borderWidth.addEventListener('input', () => {
      el.borderWidth = parseInt(borderWidth.value, 10) || 0;
      renderCanvas();
    });
    borderWidth.addEventListener('change', () => {
      markUnsaved();
      commitHistory();
    });

    // "No border" - mirrors "No fill" right next to it. Not offered for a
    // line element (its "border" is the visible line itself).
    if (!isLine) {
      const noBorder = document.createElement('input');
      noBorder.type = 'checkbox';
      noBorder.checked = !el.borderWidth || el.borderWidth === 0;
      borderColor.disabled = noBorder.checked;
      borderWidth.disabled = noBorder.checked;
      noBorder.addEventListener('change', () => {
        el.borderWidth = noBorder.checked ? 0 : (parseInt(borderWidth.value, 10) || 2);
        borderWidth.value = el.borderWidth;
        borderColor.disabled = noBorder.checked;
        borderWidth.disabled = noBorder.checked;
        renderCanvas();
        markUnsaved();
        commitHistory();
      });
      propsPanel.appendChild(propRow('No border', noBorder));
    }

    propsPanel.appendChild(propRow(isLine ? 'Line color' : 'Border color', borderColor));
    propsPanel.appendChild(propRow(isLine ? 'Thickness' : 'Border width', borderWidth));

    if (shapeType === 'rectangle' || shapeType === 'roundedRect') {
      const borderRadius = document.createElement('input');
      borderRadius.type = 'number';
      borderRadius.min = '0';
      borderRadius.max = '200';
      borderRadius.value = el.borderRadius || 0;
      borderRadius.addEventListener('input', () => {
        el.borderRadius = parseInt(borderRadius.value, 10) || 0;
        renderCanvas();
      });
      borderRadius.addEventListener('change', () => {
        markUnsaved();
        commitHistory();
      });
      propsPanel.appendChild(propRow('Corner radius', borderRadius));
    }

    const dash = document.createElement('select');
    [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']].forEach(([val, lbl]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = lbl;
      if ((el.dash || 'solid') === val) opt.selected = true;
      dash.appendChild(opt);
    });
    dash.addEventListener('change', () => {
      el.dash = dash.value;
      renderCanvas();
      markUnsaved();
      commitHistory();
    });
    propsPanel.appendChild(propRow('Line style', dash));
  }

  function renderTableProps(el) {
    const dayLabel = document.createElement('p');
    dayLabel.className = 'name-tag-mini-label';
    dayLabel.textContent = 'Day';
    propsPanel.appendChild(dayLabel);
    const dayRow = document.createElement('div');
    dayRow.className = 'name-tag-mini-btn-row';
    TABLE_FIELDS.forEach((f) => {
      dayRow.appendChild(iconToggleBtn(f.label, 'Show ' + f.label, el.field === f.field, () => { el.field = f.field; renderCanvas(); markUnsaved(); commitHistory(); renderProperties(); }));
    });
    propsPanel.appendChild(dayRow);

    const fontSize = document.createElement('input');
    fontSize.type = 'number';
    fontSize.min = '6';
    fontSize.max = '16';
    fontSize.value = el.fontSize || 8;
    fontSize.addEventListener('input', () => {
      el.fontSize = parseInt(fontSize.value, 10) || 8;
      renderCanvas();
    });
    fontSize.addEventListener('change', () => {
      markUnsaved();
      commitHistory();
    });
    propsPanel.appendChild(propRow('Font size', fontSize));

    const borderColor = document.createElement('input');
    borderColor.type = 'color';
    borderColor.value = el.borderColor || '#dbe8f5';
    borderColor.addEventListener('input', () => {
      el.borderColor = borderColor.value;
      renderCanvas();
    });
    borderColor.addEventListener('change', () => {
      markUnsaved();
      commitHistory();
    });
    propsPanel.appendChild(propRow('Grid line color', borderColor));

    const headerColor = document.createElement('input');
    headerColor.type = 'color';
    headerColor.value = el.headerColor || '#eaf4fd';
    headerColor.addEventListener('input', () => {
      el.headerColor = headerColor.value;
      renderCanvas();
    });
    headerColor.addEventListener('change', () => {
      markUnsaved();
      commitHistory();
    });
    propsPanel.appendChild(propRow('Header background', headerColor));
  }

  function renderProperties() {
    propsPanel.innerHTML = '';

    if (cropModeId) {
      const cropEl = findEl(cropModeId);
      if (cropEl && cropEl.type === 'image' && cropEl.src) {
        renderCropTool(cropEl);
        return;
      }
      cropModeId = null;
    }

    const el = findEl(selectedId);
    if (!el) return;

    const title = document.createElement('h3');
    title.textContent =
      el.type === 'text' ? 'Text: ' + (fieldLabel(el.field) || el.field) : el.type === 'table' ? 'Schedule Table: ' + (fieldLabel(el.field) || el.field) : el.type === 'image' ? 'Image' : 'Shape';
    propsPanel.appendChild(title);

    if (el.type === 'text') {
      renderTextProps(el);
    } else if (el.type === 'shape') {
      renderShapeProps(el);
    } else if (el.type === 'table') {
      renderTableProps(el);
    } else if (el.type === 'image') {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'Drag to move, use the handles to resize or rotate.';
      propsPanel.appendChild(p);
      const cropBtn = document.createElement('button');
      cropBtn.type = 'button';
      cropBtn.className = 'btn-secondary';
      cropBtn.innerHTML = '<svg class="icon"><use href="#icon-crop"/></svg> Crop Image';
      cropBtn.addEventListener('click', () => {
        cropModeId = el.id;
        renderProperties();
      });
      propsPanel.appendChild(cropBtn);
    }

    renderBaseControls(el);
  }

  function renderCropTool(el) {
    const title = document.createElement('h3');
    title.textContent = 'Crop Image';
    propsPanel.appendChild(title);
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Drag the image to reposition it, use the slider to zoom, then apply.';
    propsPanel.appendChild(hint);

    const aspect = el.width / el.height;
    const frameW = 240;
    const frameH = frameW / aspect;

    const frame = document.createElement('div');
    frame.className = 'name-tag-crop-frame';
    frame.style.width = frameW + 'px';
    frame.style.height = frameH + 'px';
    propsPanel.appendChild(frame);

    const previewImg = document.createElement('img');
    previewImg.className = 'name-tag-crop-image';
    frame.appendChild(previewImg);

    const zoomRow = document.createElement('div');
    zoomRow.className = 'name-tag-prop-row';
    const zoomLabel = document.createElement('label');
    zoomLabel.textContent = 'Zoom';
    const zoomInput = document.createElement('input');
    zoomInput.type = 'range';
    zoomInput.min = '1';
    zoomInput.max = '3';
    zoomInput.step = '0.05';
    zoomRow.appendChild(zoomLabel);
    zoomRow.appendChild(zoomInput);
    propsPanel.appendChild(zoomRow);

    const actions = document.createElement('div');
    actions.className = 'name-tag-crop-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = 'Cancel';
    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'primary-btn';
    applyBtn.textContent = 'Apply Crop';
    actions.appendChild(cancelBtn);
    actions.appendChild(applyBtn);
    propsPanel.appendChild(actions);

    const img = new Image();
    img.onload = function () {
      const naturalW = el.naturalWidth || img.naturalWidth;
      const naturalH = el.naturalHeight || img.naturalHeight;
      let fitW, fitH;
      if (naturalW / naturalH > aspect) {
        fitH = naturalH;
        fitW = naturalH * aspect;
      } else {
        fitW = naturalW;
        fitH = naturalW / aspect;
      }

      let zoomVal = 1;
      let cropW = fitW;
      let cropH = fitH;
      let cropX = (naturalW - cropW) / 2;
      let cropY = (naturalH - cropH) / 2;
      if (el.cropW) {
        cropW = el.cropW;
        cropH = el.cropH;
        cropX = el.cropX;
        cropY = el.cropY;
        zoomVal = clamp(fitW / cropW, 1, 3);
      }
      zoomInput.value = String(zoomVal);

      let scale = frameW / cropW;

      function paint() {
        cropW = fitW / zoomVal;
        cropH = fitH / zoomVal;
        cropX = clamp(cropX, 0, Math.max(0, naturalW - cropW));
        cropY = clamp(cropY, 0, Math.max(0, naturalH - cropH));
        scale = frameW / cropW;
        previewImg.style.width = naturalW * scale + 'px';
        previewImg.style.height = naturalH * scale + 'px';
        previewImg.style.left = -cropX * scale + 'px';
        previewImg.style.top = -cropY * scale + 'px';
      }
      previewImg.src = el.src;
      paint();

      zoomInput.addEventListener('input', () => {
        const cx = cropX + cropW / 2;
        const cy = cropY + cropH / 2;
        zoomVal = parseFloat(zoomInput.value);
        cropW = fitW / zoomVal;
        cropH = fitH / zoomVal;
        cropX = cx - cropW / 2;
        cropY = cy - cropH / 2;
        paint();
      });

      frame.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startY = e.clientY;
        const ox = cropX;
        const oy = cropY;
        function onMove(ev) {
          cropX = ox - (ev.clientX - startX) / scale;
          cropY = oy - (ev.clientY - startY) / scale;
          paint();
        }
        function onUp() {
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onUp);
        }
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
      });

      cancelBtn.addEventListener('click', () => {
        cropModeId = null;
        renderProperties();
      });
      applyBtn.addEventListener('click', () => {
        el.naturalWidth = naturalW;
        el.naturalHeight = naturalH;
        el.cropX = cropX;
        el.cropY = cropY;
        el.cropW = cropW;
        el.cropH = cropH;
        cropModeId = null;
        renderCanvas();
        markUnsaved();
        commitHistory();
        renderProperties();
      });
    };
    img.src = el.src;
  }

  // ---------- Add element tools ----------
  function addField(field) {
    const el = {
      id: newId('text'),
      type: 'text',
      field,
      x: 10,
      y: 10,
      width: 200,
      height: 30,
      fontSize: 16,
      color: '#1c2530',
      bold: false,
      align: 'center',
      valign: 'middle',
    };
    if (field === 'custom') el.text = 'New Text';
    currentLayout().push(el);
    selectedId = el.id;
    renderCanvas();
    markUnsaved();
    commitHistory();
    renderProperties();
  }

  const ELEMENT_SIZES = {
    small: { width: 60, height: 30 },
    medium: { width: 120, height: 60 },
    large: { width: 200, height: 100 },
  };

  function addElement(shapeType, size) {
    const dims = ELEMENT_SIZES[size] || ELEMENT_SIZES.medium;
    const el = {
      id: newId('shape'),
      type: 'shape',
      shapeType,
      x: 20,
      y: 20,
      width: dims.width,
      height: dims.height,
      fill: 'transparent',
      borderColor: '#1c2530',
      borderWidth: 2,
      borderRadius: shapeType === 'roundedRect' ? 14 : 0,
      dash: 'solid',
    };
    if (shapeType === 'circle') {
      el.height = el.width;
      el.borderRadius = 999;
    } else if (shapeType === 'line') {
      el.height = 4;
      el.fill = '#1c2530';
      el.borderWidth = 0;
    } else if (shapeType === 'star' || shapeType === 'polygon' || shapeType === 'diamond') {
      el.fill = '#e2e8f0';
    }
    currentLayout().push(el);
    selectedId = el.id;
    renderCanvas();
    markUnsaved();
    commitHistory();
    renderProperties();
  }

  function addTable(day) {
    const field = day === 'wednesday' ? 'wednesdaySchedule' : 'mondaySchedule';
    const el = { id: newId('table'), type: 'table', field, x: 20, y: 20, width: 154, height: 145, fontSize: 8, borderColor: '#dbe8f5', headerColor: '#eaf4fd' };
    currentLayout().push(el);
    selectedId = el.id;
    renderCanvas();
    markUnsaved();
    commitHistory();
    renderProperties();
  }

  async function uploadImage(file) {
    const formData = new FormData();
    formData.append('image', file);
    try {
      const res = await fetch(BASE_PATH + '/design-image', { method: 'POST', headers: { 'X-CSRF-Token': window.CSRF_TOKEN || '' }, body: formData });
      const data = await res.json();
      if (data.ok) {
        const el = { id: newId('image'), type: 'image', src: data.url, x: 10, y: 10, width: 100, height: 100 };
        const probe = new Image();
        probe.onload = function () {
          el.naturalWidth = probe.naturalWidth;
          el.naturalHeight = probe.naturalHeight;
        };
        probe.src = data.url;
        currentLayout().push(el);
        selectedId = el.id;
        renderCanvas();
        markUnsaved();
        commitHistory();
        renderProperties();
      } else {
        alert(data.message || 'Could not upload that image.');
      }
    } catch (err) {
      alert('Connection error uploading image.');
    }
  }

  function renderToolPanel() {
    const tool = currentTool;
    toolPanel.innerHTML = '';

    if (tool === 'add-field') {
      const row = document.createElement('div');
      row.className = 'name-tag-add-field';
      const select = document.createElement('select');
      FIELDS.forEach((f) => {
        const opt = document.createElement('option');
        opt.value = f.field;
        opt.textContent = f.label;
        select.appendChild(opt);
      });
      const customOpt = document.createElement('option');
      customOpt.value = 'custom';
      customOpt.textContent = 'Custom Text…';
      select.appendChild(customOpt);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-secondary';
      btn.textContent = '+ Add to Card';
      btn.addEventListener('click', () => addField(select.value));
      row.appendChild(select);
      row.appendChild(btn);
      toolPanel.appendChild(row);
    } else if (tool === 'add-table') {
      const row = document.createElement('div');
      row.className = 'name-tag-add-field';
      const select = document.createElement('select');
      TABLE_FIELDS.forEach((f) => {
        const opt = document.createElement('option');
        opt.value = f.day;
        opt.textContent = f.label;
        select.appendChild(opt);
      });
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-secondary';
      btn.textContent = '+ Add to Card';
      btn.addEventListener('click', () => addTable(select.value));
      row.appendChild(select);
      row.appendChild(btn);
      toolPanel.appendChild(row);
    } else if (tool === 'add-shape') {
      const wrap = document.createElement('div');
      wrap.className = 'name-tag-add-element';

      const shapePicker = document.createElement('div');
      shapePicker.className = 'name-tag-shape-picker';
      let selectedShape = SHAPE_TYPES.length ? SHAPE_TYPES[0].value : 'rectangle';
      const shapeButtons = SHAPE_TYPES.map((shape) => {
        const shapeBtn = document.createElement('button');
        shapeBtn.type = 'button';
        shapeBtn.className = 'name-tag-shape-btn' + (shape.value === selectedShape ? ' active' : '');
        shapeBtn.setAttribute('aria-label', shape.label);
        shapeBtn.title = shape.label;
        shapeBtn.innerHTML = '<svg class="icon"><use href="' + shape.icon + '"/></svg>';
        shapeBtn.addEventListener('click', () => {
          selectedShape = shape.value;
          shapeButtons.forEach((b) => b.classList.remove('active'));
          shapeBtn.classList.add('active');
        });
        shapePicker.appendChild(shapeBtn);
        return shapeBtn;
      });
      wrap.appendChild(shapePicker);

      const sizeSelect = document.createElement('select');
      [
        ['small', 'Small'],
        ['medium', 'Medium'],
        ['large', 'Large'],
      ].forEach(([val, sizeLabel]) => {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = sizeLabel;
        if (val === 'medium') opt.selected = true;
        sizeSelect.appendChild(opt);
      });
      wrap.appendChild(sizeSelect);

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'btn-secondary';
      addBtn.textContent = '+ Add to Card';
      addBtn.addEventListener('click', () => addElement(selectedShape, sizeSelect.value));
      wrap.appendChild(addBtn);

      toolPanel.appendChild(wrap);
    } else if (tool === 'add-image') {
      const label = document.createElement('label');
      label.className = 'btn-secondary name-tag-upload-label';
      label.textContent = '+ Choose Image File';
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.hidden = true;
      input.addEventListener('change', (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (file) uploadImage(file);
      });
      label.appendChild(input);
      toolPanel.appendChild(label);
    } else if (tool === 'background') {
      const wrap = document.createElement('div');
      wrap.className = 'name-tag-bg-tool';

      const colorLabel = document.createElement('label');
      colorLabel.className = 'name-tag-bg-label';
      colorLabel.textContent = 'Background Color';
      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.value = layout.background || '#ffffff';
      colorInput.addEventListener('input', () => {
        layout.background = colorInput.value;
        renderCanvas();
      });
      colorInput.addEventListener('change', () => {
        markUnsaved();
        commitHistory();
      });
      colorLabel.appendChild(colorInput);
      wrap.appendChild(colorLabel);

      const opacityInput = document.createElement('input');
      opacityInput.type = 'range';
      opacityInput.min = '0';
      opacityInput.max = '100';
      opacityInput.step = '5';
      const currentOpacity = layout.backgroundOpacity;
      opacityInput.value = Math.round((currentOpacity == null ? 1 : currentOpacity) * 100);
      opacityInput.addEventListener('input', () => {
        layout.backgroundOpacity = parseInt(opacityInput.value, 10) / 100;
        renderCanvas();
      });
      opacityInput.addEventListener('change', () => {
        markUnsaved();
        commitHistory();
      });
      wrap.appendChild(propRow('Background Opacity', opacityInput));

      toolPanel.appendChild(wrap);
    }
  }

  // The design editor only exists on the Design Cards tab - Print Cards
  // renders a different tab panel entirely.
  if (canvas) {
    if (toolIcons) {
      toolIcons.querySelectorAll('.name-tag-tool-icon-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          currentTool = btn.dataset.tool;
          toolIcons.querySelectorAll('.name-tag-tool-icon-btn').forEach((b) => b.classList.toggle('active', b === btn));
          renderToolPanel();
        });
      });
    }

    if (undoBtn) undoBtn.addEventListener('click', undo);
    if (redoBtn) redoBtn.addEventListener('click', redo);

    if (zoomSelect) {
      zoomSelect.addEventListener('change', () => {
        zoom = parseFloat(zoomSelect.value) || 1;
        applyZoom();
      });
    }
    if (gridToggleBtn) {
      gridToggleBtn.addEventListener('click', () => {
        showGrid = !showGrid;
        gridToggleBtn.classList.toggle('active', showGrid);
        updateGridOverlay();
      });
    }
    if (snapToggleBtn) {
      snapToggleBtn.addEventListener('click', () => {
        snapToGrid = !snapToGrid;
        snapToggleBtn.classList.toggle('active', snapToGrid);
      });
    }

    document.getElementById('schedule-card-reset-btn').addEventListener('click', () => {
      if (!confirm('Reset the Schedule Card design to the default layout? This discards unsaved changes.')) return;
      layout = cloneLayout(DEFAULT_LAYOUT);
      selectedId = null;
      cropModeId = null;
      renderCanvas();
      renderProperties();
      markUnsaved();
      commitHistory();
    });

    document.getElementById('schedule-card-save-btn').addEventListener('click', async () => {
      saveStatus.textContent = 'Saving…';
      try {
        const res = await fetch(BASE_PATH + '/design/template', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.CSRF_TOKEN || '' },
          body: JSON.stringify({ layout }),
        });
        const data = await res.json();
        saveStatus.textContent = data.ok ? 'Saved!' : 'Could not save.';
      } catch (err) {
        saveStatus.textContent = 'Connection error.';
      }
    });

    document.addEventListener('keydown', (e) => {
      const activeTag = (document.activeElement && document.activeElement.tagName) || '';
      const editable = document.activeElement && document.activeElement.isContentEditable;
      if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT' || editable) return;
      if (document.getElementById('schedule-card-editor').offsetParent === null) return;

      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        redo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        const el = findEl(selectedId);
        if (el) {
          e.preventDefault();
          duplicateElement(el);
        }
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        const el = findEl(selectedId);
        if (el && !el.locked) {
          e.preventDefault();
          deleteElement(el);
        }
      }
    });

    applyZoom();
    renderProperties();
    refreshHistoryButtons();
    autoFitZoomToViewport();
  }
})();
