(function () {
  const dataEl = document.getElementById('name-tag-data');
  if (!dataEl) return;

  const Render = window.NameTagRenderCore;
  const seed = JSON.parse(dataEl.textContent);
  const BADGE_WIDTH = seed.badgeWidth;
  const BADGE_HEIGHT = seed.badgeHeight;
  const FIELDS_BY_TYPE = seed.fieldsByType;
  const DEFAULT_LAYOUTS = seed.defaultLayouts;
  const SHAPE_TYPES = seed.shapeTypes || [];
  const FONT_FAMILIES = seed.fontFamilies || [];
  const GRID_SIZE = 8;
  const MIN_SIZE = 12;
  // The two real per-member name tags "Copy Design to All Name Tags" can
  // copy between - matches routes/admin-name-tag.js's own NAME_TAG_TYPES.
  // setupCleanup/custom are a different badge shape (Badge Number/Title/
  // Description, not member fields - see utils/nameTagBadge.js's
  // FIELDS_BY_TYPE comment), so copying between those and student/parent
  // wouldn't carry over anything meaningful.
  const NAME_TAG_TYPES = ['student', 'parent', 'admin'];

  function cloneLayout(layout) {
    return JSON.parse(JSON.stringify(layout || {}));
  }

  // Caps a drag/resize/rotate callback to at most once per animation
  // frame. A touchscreen (especially high-polling-rate ones) can fire
  // pointermove far faster than the screen actually repaints - re-running
  // renderCanvas()'s full innerHTML rebuild on every single one of those
  // events (not just once per frame) is what made mobile dragging feel
  // sluggish.
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
  // student/parent are per-member name tags; setupCleanup/custom are the
  // two non-member "misc badge" types (see utils/miscBadgeData.js) - same
  // editor, own save table server-side.
  const layouts = {
    student: cloneLayout(seed.templates.student),
    parent: cloneLayout(seed.templates.parent),
    admin: cloneLayout(seed.templates.admin),
    setupCleanup: cloneLayout(seed.templates.setupCleanup),
    custom: cloneLayout(seed.templates.custom),
  };

  const PLACEHOLDER_DATA = {
    student: { name: 'Alex Student', gradeLevel: '5th Grade', allergies: 'Peanut allergy', memberCode: 'ID#012345', barcodeValue: '0123456789' },
    parent: {
      name: 'Jordan Parent',
      cleanupTeam: 'Chairs & Tables, Snack Table',
      mondaySetupCleanup: 'Monday: Chairs & Tables',
      wednesdaySetupCleanup: 'Wednesday: Snack Table',
      setupCleanupDays: ['Monday: Chairs & Tables', 'Wednesday: Snack Table'],
      memberCode: 'ID#012345',
      barcodeValue: '0123456789',
    },
    admin: { name: 'Sam Admin', adminPosition: 'President', memberCode: 'ID#012345', barcodeValue: '0123456789' },
    setupCleanup: { day: 'Monday', title: 'Snack Table', leaderLabel: 'Leader: Jordan Parent', description: 'Set up the snack table and chairs before 9am.', barcodeValue: '012345' },
    custom: { badgeNumber: '', title: 'Sample Badge', description: 'Custom badge text goes here.' },
  };

  let currentType = 'student';
  let currentTool = '';
  let selectedId = null;
  let cropModeId = null;
  let idCounter = 1;
  let zoom = 1;
  let showGrid = false;
  let snapToGrid = false;

  const history = {}; // { [type]: { stack: [layoutSnapshot,...], index } }

  const canvas = document.getElementById('name-tag-canvas');
  const zoomWrap = document.getElementById('name-tag-canvas-zoom-wrap');
  const gridOverlay = document.getElementById('name-tag-grid-overlay');
  const overlayLayer = document.getElementById('name-tag-selection-overlay');
  const propsPanel = document.getElementById('name-tag-properties');
  const typeSelect = document.getElementById('name-tag-type-select');
  const toolIcons = document.getElementById('name-tag-tool-icons');
  const toolPanel = document.getElementById('name-tag-tool-panel');
  const saveStatus = document.getElementById('save-status');
  const copyDesignBtn = document.getElementById('copy-design-btn');
  const undoBtn = document.getElementById('undo-btn');
  const redoBtn = document.getElementById('redo-btn');
  const zoomSelect = document.getElementById('name-tag-zoom-select');
  const gridToggleBtn = document.getElementById('grid-toggle-btn');
  const snapToggleBtn = document.getElementById('snap-toggle-btn');

  function currentTemplate() {
    return layouts[currentType];
  }

  function currentLayout() {
    return layouts[currentType].elements;
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
  function historyFor(type) {
    if (!history[type]) history[type] = { stack: [cloneLayout(layouts[type])], index: 0 };
    return history[type];
  }

  function commitHistory() {
    const hist = historyFor(currentType);
    hist.stack = hist.stack.slice(0, hist.index + 1);
    hist.stack.push(cloneLayout(currentTemplate()));
    if (hist.stack.length > 60) hist.stack.shift();
    hist.index = hist.stack.length - 1;
    refreshHistoryButtons();
  }

  function undo() {
    const hist = historyFor(currentType);
    if (hist.index <= 0) return;
    hist.index--;
    layouts[currentType] = cloneLayout(hist.stack[hist.index]);
    selectedId = null;
    cropModeId = null;
    renderCanvas();
    renderProperties();
    markUnsaved();
    refreshHistoryButtons();
  }

  function redo() {
    const hist = historyFor(currentType);
    if (hist.index >= hist.stack.length - 1) return;
    hist.index++;
    layouts[currentType] = cloneLayout(hist.stack[hist.index]);
    selectedId = null;
    cropModeId = null;
    renderCanvas();
    renderProperties();
    markUnsaved();
    refreshHistoryButtons();
  }

  function refreshHistoryButtons() {
    const hist = historyFor(currentType);
    if (undoBtn) undoBtn.disabled = hist.index <= 0;
    if (redoBtn) redoBtn.disabled = hist.index >= hist.stack.length - 1;
  }

  function markUnsaved() {
    saveStatus.textContent = 'Unsaved changes';
  }

  // ---------- Canvas rendering ----------
  function renderCanvas() {
    const tpl = currentTemplate();
    canvas.style.background = Render.backgroundCss(tpl.background, tpl.backgroundOpacity);
    canvas.innerHTML = Render.renderBadgeElements(tpl.elements, PLACEHOLDER_DATA[currentType]);

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
    if (window.renderNameTagBarcodes) window.renderNameTagBarcodes(canvas);
    // Real browser-measured correction on top of Render.fitFontSize's own
    // server-render-time estimate (see public/js/badge-autofit.js's own
    // comment on why the estimate alone isn't enough) - keeps the live
    // design canvas matching what actually prints instead of only
    // matching what the estimate predicted would print.
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
    gridOverlay.style.width = BADGE_WIDTH * zoom + 'px';
    gridOverlay.style.height = BADGE_HEIGHT * zoom + 'px';
    const size = GRID_SIZE * zoom;
    gridOverlay.style.backgroundSize = size + 'px ' + size + 'px';
  }

  function applyZoom() {
    canvas.style.transform = 'scale(' + zoom + ')';
    canvas.style.transformOrigin = 'top left';
    zoomWrap.style.width = BADGE_WIDTH * zoom + 'px';
    zoomWrap.style.height = BADGE_HEIGHT * zoom + 'px';
    renderCanvas();
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
      el.x = clamp(nx, 0, Math.max(0, BADGE_WIDTH - el.width));
      el.y = clamp(ny, 0, Math.max(0, BADGE_HEIGHT - el.height));
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

  // Handle -> which opposite corner/edge stays fixed (anchor), as a
  // direction multiplier applied to the ORIGINAL half-width/half-height.
  const HANDLE_ANCHOR = {
    nw: [1, 1], n: [0, 1], ne: [-1, 1], e: [-1, 0],
    se: [-1, -1], s: [0, -1], sw: [1, -1], w: [1, 0],
  };
  // Handle -> which local-space delta axis grows width/height, and in
  // which direction.
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
      // Rotate the screen-space delta into the element's own (unrotated)
      // coordinate frame so resizing a rotated element still tracks the
      // pointer correctly.
      const localDx = dx * cosT + dy * sinT;
      const localDy = -dx * sinT + dy * cosT;

      let newW = Math.max(MIN_SIZE, originW + delta[0] * localDx);
      let newH = Math.max(MIN_SIZE, originH + delta[1] * localDy);
      if (snapToGrid) {
        newW = Math.max(MIN_SIZE, Math.round(newW / GRID_SIZE) * GRID_SIZE);
        newH = Math.max(MIN_SIZE, Math.round(newH / GRID_SIZE) * GRID_SIZE);
      }

      // The corner/edge opposite the dragged handle must stay put on
      // screen - find its position in parent space, then rebuild x/y from
      // the new center relative to that fixed anchor.
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
    copy.x = clamp(el.x + 12, 0, Math.max(0, BADGE_WIDTH - el.width));
    copy.y = clamp(el.y + 12, 0, Math.max(0, BADGE_HEIGHT - el.height));
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
    else if (mode === 'center-h') el.x = (BADGE_WIDTH - el.width) / 2;
    else if (mode === 'right') el.x = BADGE_WIDTH - el.width;
    else if (mode === 'top') el.y = 0;
    else if (mode === 'middle-v') el.y = (BADGE_HEIGHT - el.height) / 2;
    else if (mode === 'bottom') el.y = BADGE_HEIGHT - el.height;
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
    const found = (FIELDS_BY_TYPE[currentType] || []).find((f) => f.field === field);
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
    alignLabel.textContent = 'Align on badge';
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

    // Auto-shrinks this field's font size (down to a floor) whenever its
    // actual text is too long to fit on one line at the size above - a
    // long name doesn't get to overflow/wrap and throw off the layout.
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

    const letterSpacing = document.createElement('input');
    letterSpacing.type = 'number';
    letterSpacing.min = '-2';
    letterSpacing.max = '10';
    letterSpacing.step = '0.5';
    letterSpacing.value = el.letterSpacing || 0;
    letterSpacing.addEventListener('input', () => {
      el.letterSpacing = parseFloat(letterSpacing.value) || 0;
      renderCanvas();
    });
    letterSpacing.addEventListener('change', () => {
      markUnsaved();
      commitHistory();
    });
    propsPanel.appendChild(propRow('Letter spacing', letterSpacing));

    const lineHeight = document.createElement('input');
    lineHeight.type = 'number';
    lineHeight.min = '0.8';
    lineHeight.max = '2.5';
    lineHeight.step = '0.05';
    lineHeight.value = el.lineHeight || 1.15;
    lineHeight.addEventListener('input', () => {
      el.lineHeight = parseFloat(lineHeight.value) || 1.15;
      renderCanvas();
    });
    lineHeight.addEventListener('change', () => {
      markUnsaved();
      commitHistory();
    });
    propsPanel.appendChild(propRow('Line spacing', lineHeight));

    const textCase = document.createElement('select');
    [['none', 'Normal'], ['uppercase', 'UPPERCASE'], ['lowercase', 'lowercase']].forEach(([val, lbl]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = lbl;
      if ((el.textCase || 'none') === val) opt.selected = true;
      textCase.appendChild(opt);
    });
    textCase.addEventListener('change', () => {
      el.textCase = textCase.value;
      renderCanvas();
      markUnsaved();
      commitHistory();
    });
    propsPanel.appendChild(propRow('Text case', textCase));

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

    // "No border" - a shape's outline (not a line element - a line's own
    // "border" IS the visible line, so that toggle would just hide it).
    // Mirrors "No fill" right next to it: sets width to 0 (transparent
    // renders the same either way) and disables the color/width inputs
    // until unchecked, restoring a sensible 2px default rather than
    // leaving them at 0 with nothing to type over.
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
      el.type === 'text' ? 'Text: ' + (fieldLabel(el.field) || el.field) : el.type === 'barcode' ? 'Barcode' : el.type === 'image' ? 'Image' : 'Shape';
    propsPanel.appendChild(title);

    if (el.type === 'text') {
      renderTextProps(el);
    } else if (el.type === 'shape') {
      renderShapeProps(el);
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
    } else if (el.type === 'barcode') {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = "Shows each member's real barcode when printed. Drag to move, use the handles to resize or rotate.";
      propsPanel.appendChild(p);
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

  function addBarcode() {
    const el = { id: newId('barcode'), type: 'barcode', x: 43, y: 150, width: 250, height: 55 };
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
      const res = await fetch('/admin/name-tag/design-image', {
        method: 'POST',
        headers: { Accept: 'application/json', 'X-CSRF-Token': window.CSRF_TOKEN || '' },
        body: formData,
      });
      // A session that expired mid-edit gets a redirect to the login page
      // here, not a JSON body - res.json() below would throw on that and
      // get misreported as a generic connection error, not what actually
      // happened.
      if (res.status === 401) {
        alert('Your session has expired. Please refresh the page and log in again.');
        return;
      }
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

  // The toolbar is a row of icon buttons - clicking one reveals just that
  // tool's controls in the small panel below it, instead of a dropdown or
  // a permanent row of button groups.
  function renderToolPanel() {
    const tool = currentTool;
    toolPanel.innerHTML = '';

    if (tool === 'add-field') {
      const row = document.createElement('div');
      row.className = 'name-tag-add-field';
      const select = document.createElement('select');
      (FIELDS_BY_TYPE[currentType] || []).forEach((f) => {
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
      btn.textContent = '+ Add to Badge';
      btn.addEventListener('click', () => addField(select.value));
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
      addBtn.textContent = '+ Add to Badge';
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
    } else if (tool === 'add-barcode') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-secondary';
      btn.textContent = '+ Add Barcode to Badge';
      btn.addEventListener('click', addBarcode);
      toolPanel.appendChild(btn);
    } else if (tool === 'background') {
      const wrap = document.createElement('div');
      wrap.className = 'name-tag-bg-tool';

      const colorLabel = document.createElement('label');
      colorLabel.className = 'name-tag-bg-label';
      colorLabel.textContent = 'Background Color';
      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.value = currentTemplate().background || '#ffffff';
      colorInput.addEventListener('input', () => {
        currentTemplate().background = colorInput.value;
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
      const currentOpacity = currentTemplate().backgroundOpacity;
      opacityInput.value = Math.round((currentOpacity == null ? 1 : currentOpacity) * 100);
      opacityInput.addEventListener('input', () => {
        currentTemplate().backgroundOpacity = parseInt(opacityInput.value, 10) / 100;
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

  function switchType(type) {
    currentType = type;
    selectedId = null;
    cropModeId = null;
    typeSelect.value = type;
    currentTool = '';
    if (toolIcons) toolIcons.querySelectorAll('.name-tag-tool-icon-btn').forEach((b) => b.classList.remove('active'));
    renderToolPanel();
    renderCanvas();
    renderProperties();
    saveStatus.textContent = '';
    refreshHistoryButtons();
    if (copyDesignBtn) copyDesignBtn.hidden = !NAME_TAG_TYPES.includes(type);
  }

  async function saveTemplateToServer(type, layout) {
    const res = await fetch('/admin/name-tag/template/' + type, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': window.CSRF_TOKEN || '' },
      body: JSON.stringify({ layout }),
    });
    if (res.status === 401) return { ok: false, expired: true };
    return res.json();
  }

  // The design editor's canvas/tool-select/etc. only exist on the Design
  // tab - Print/Requests/Archived render a different tab panel entirely.
  if (canvas) {
    typeSelect.addEventListener('change', () => switchType(typeSelect.value));

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

    document.getElementById('reset-template-btn').addEventListener('click', () => {
      if (!confirm('Reset the ' + currentType + ' badge design to the default layout? This discards unsaved changes.')) return;
      layouts[currentType] = cloneLayout(DEFAULT_LAYOUTS[currentType]);
      selectedId = null;
      cropModeId = null;
      renderCanvas();
      renderProperties();
      markUnsaved();
      commitHistory();
    });

    document.getElementById('save-template-btn').addEventListener('click', async () => {
      saveStatus.textContent = 'Saving…';
      try {
        const data = await saveTemplateToServer(currentType, currentTemplate());
        // See uploadImage above for why the 401 check exists.
        saveStatus.textContent = data.expired ? 'Session expired - please refresh and log in again.' : data.ok ? 'Saved!' : 'Could not save.';
      } catch (err) {
        saveStatus.textContent = 'Connection error.';
      }
    });

    if (copyDesignBtn) {
      copyDesignBtn.addEventListener('click', async () => {
        // "Copy design to all name tags" - with a 3rd type (Admin) added
        // alongside Student/Parent, "all" now genuinely means every OTHER
        // type, not just a single one, so this loops rather than picking
        // one via .find() the way it did back when there were only ever
        // two types.
        const otherTypes = NAME_TAG_TYPES.filter((t) => t !== currentType);
        if (otherTypes.length === 0) return;
        const otherLabel = otherTypes.join(' and ');
        if (!confirm('Copy the ' + currentType + ' name tag\'s design to the ' + otherLabel + ' name tag(s)? This overwrites their design (saved and unsaved) with a copy of this one.')) return;

        saveStatus.textContent = 'Saving…';
        try {
          // Save the current type first - what gets copied should be
          // exactly what's on screen, including any not-yet-saved edits,
          // not whatever was last persisted.
          const currentSave = await saveTemplateToServer(currentType, currentTemplate());
          if (currentSave.expired) { saveStatus.textContent = 'Session expired - please refresh and log in again.'; return; }
          if (!currentSave.ok) { saveStatus.textContent = 'Could not save.'; return; }

          const copied = cloneLayout(currentTemplate());
          let allOk = true;
          for (const otherType of otherTypes) {
            layouts[otherType] = cloneLayout(copied);
            // Reset the other type's undo/redo history to start fresh from
            // this copy, same shape historyFor() lazily creates - otherwise
            // switching to it and hitting Undo would jump back to whatever
            // it looked like before the copy.
            history[otherType] = { stack: [cloneLayout(copied)], index: 0 };

            const otherSave = await saveTemplateToServer(otherType, cloneLayout(copied));
            if (otherSave.expired) { saveStatus.textContent = 'Session expired - please refresh and log in again.'; return; }
            if (!otherSave.ok) allOk = false;
          }
          saveStatus.textContent = allOk ? 'Copied to ' + otherLabel + '!' : 'Could not save every copy.';
        } catch (err) {
          saveStatus.textContent = 'Connection error.';
        }
      });
    }

    document.addEventListener('keydown', (e) => {
      const activeTag = (document.activeElement && document.activeElement.tagName) || '';
      const editable = document.activeElement && document.activeElement.isContentEditable;
      if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT' || editable) return;
      if (document.getElementById('name-tag-editor').offsetParent === null) return;

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
    switchType('student');
  }

  // --- Bulk print list filtering (Print tab) ---
  const bulkList = document.getElementById('name-tag-bulk-list');
  if (bulkList) {
    const filterSelect = document.getElementById('name-tag-bulk-filter-select');
    if (filterSelect) {
      filterSelect.addEventListener('change', () => {
        const filter = filterSelect.value;
        bulkList.querySelectorAll('.member-picker-row').forEach((row) => {
          row.style.display = filter === 'all' || row.dataset.type === filter ? '' : 'none';
        });
      });
    }

    // "Select All Shown" toggles every currently-visible row's checkbox to
    // match it. "Select None Shown" is a one-shot action rendered as a
    // checkbox to match: checking it clears every visible row, then resets
    // itself back to unchecked.
    const selectAllCheckbox = document.getElementById('name-tag-select-all-checkbox');
    if (selectAllCheckbox) {
      selectAllCheckbox.addEventListener('change', () => {
        bulkList.querySelectorAll('.member-picker-row').forEach((row) => {
          if (row.style.display !== 'none') row.querySelector('input[type="checkbox"]').checked = selectAllCheckbox.checked;
        });
      });
    }

    const selectNoneCheckbox = document.getElementById('name-tag-select-none-checkbox');
    if (selectNoneCheckbox) {
      selectNoneCheckbox.addEventListener('change', () => {
        if (selectNoneCheckbox.checked) {
          bulkList.querySelectorAll('.member-picker-row').forEach((row) => {
            if (row.style.display !== 'none') row.querySelector('input[type="checkbox"]').checked = false;
          });
          if (selectAllCheckbox) selectAllCheckbox.checked = false;
          selectNoneCheckbox.checked = false;
        }
      });
    }
  }
})();
