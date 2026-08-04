(function () {
  const dataEl = document.getElementById('name-tag-data');
  if (!dataEl) return;

  const seed = JSON.parse(dataEl.textContent);
  const BADGE_WIDTH = seed.badgeWidth;
  const BADGE_HEIGHT = seed.badgeHeight;
  const FIELDS_BY_TYPE = seed.fieldsByType;
  const DEFAULT_LAYOUTS = seed.defaultLayouts;
  function cloneLayout(layout) {
    return JSON.parse(JSON.stringify(layout || []));
  }

  // Working copy - edits happen here until "Save Template" persists them.
  const layouts = {
    student: cloneLayout(seed.templates.student),
    parent: cloneLayout(seed.templates.parent),
    admin: cloneLayout(seed.templates.admin),
  };

  const PLACEHOLDER_DATA = {
    student: { name: 'Alex Student', gradeLevel: '5th Grade', allergies: 'Peanut allergy', barcodeValue: '0123456789' },
    parent: { name: 'Jordan Parent', cleanupTeam: 'Chairs & Tables', barcodeValue: '0123456789' },
    admin: { name: 'Sam Admin', barcodeValue: '0123456789' },
  };

  let currentType = 'student';
  let selectedId = null;
  let idCounter = 1;

  const canvas = document.getElementById('name-tag-canvas');
  const propsPanel = document.getElementById('name-tag-properties');
  const typeSelect = document.getElementById('name-tag-type-select');
  const toolSelect = document.getElementById('name-tag-tool-select');
  const toolPanel = document.getElementById('name-tag-tool-panel');
  const saveStatus = document.getElementById('save-status');

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

  function justifyForAlign(align) {
    return align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center';
  }

  function renderCanvas() {
    canvas.innerHTML = '';
    canvas.style.background = currentTemplate().background || '#ffffff';
    currentLayout().forEach((el) => {
      const node =
        el.type === 'image'
          ? document.createElement('img')
          : el.type === 'barcode'
          ? document.createElementNS('http://www.w3.org/2000/svg', 'svg')
          : document.createElement('div');
      if (el.type === 'barcode') {
        node.setAttribute('class', 'badge-el badge-el-' + el.type);
      } else {
        node.className = 'badge-el badge-el-' + el.type;
      }
      node.dataset.id = el.id;
      node.style.left = el.x + 'px';
      node.style.top = el.y + 'px';
      node.style.width = el.width + 'px';
      node.style.height = el.height + 'px';

      if (el.type === 'text') {
        node.style.fontSize = el.fontSize + 'px';
        node.style.color = el.color;
        node.style.fontWeight = el.bold ? '700' : '400';
        node.style.justifyContent = justifyForAlign(el.align);
        node.textContent = (PLACEHOLDER_DATA[currentType] && PLACEHOLDER_DATA[currentType][el.field]) || '';
      } else if (el.type === 'shape') {
        node.style.background = el.fill || 'transparent';
        node.style.border = (el.borderWidth || 0) + 'px solid ' + (el.borderColor || 'transparent');
        node.style.borderRadius = (el.borderRadius || 0) + 'px';
      } else if (el.type === 'image') {
        node.src = el.src;
        node.alt = '';
      } else if (el.type === 'barcode') {
        node.dataset.barcodeValue = PLACEHOLDER_DATA[currentType].barcodeValue;
      }

      if (el.id === selectedId) node.classList.add('badge-el-selected');

      const handle = document.createElement('div');
      handle.className = 'badge-el-resize-handle';
      handle.addEventListener('mousedown', (e) => startResize(e, el));
      node.appendChild(handle);

      node.addEventListener('mousedown', (e) => startDrag(e, el));
      canvas.appendChild(node);
    });

    if (window.renderNameTagBarcodes) window.renderNameTagBarcodes(canvas);
  }

  function startDrag(e, el) {
    if (e.target.classList.contains('badge-el-resize-handle')) return;
    e.preventDefault();
    selectedId = el.id;
    renderCanvas();
    renderProperties();

    const startX = e.clientX;
    const startY = e.clientY;
    const originX = el.x;
    const originY = el.y;
    let moved = false;

    function onMove(ev) {
      moved = true;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      el.x = Math.max(0, Math.min(BADGE_WIDTH - el.width, originX + dx));
      el.y = Math.max(0, Math.min(BADGE_HEIGHT - el.height, originY + dy));
      const node = canvas.querySelector('[data-id="' + el.id + '"]');
      if (node) {
        node.style.left = el.x + 'px';
        node.style.top = el.y + 'px';
      }
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (moved) markUnsaved();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function startResize(e, el) {
    e.preventDefault();
    e.stopPropagation();
    selectedId = el.id;
    const startX = e.clientX;
    const startY = e.clientY;
    const originW = el.width;
    const originH = el.height;

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      el.width = Math.max(20, Math.min(BADGE_WIDTH - el.x, originW + dx));
      el.height = Math.max(16, Math.min(BADGE_HEIGHT - el.y, originH + dy));
      const node = canvas.querySelector('[data-id="' + el.id + '"]');
      if (node) {
        node.style.width = el.width + 'px';
        node.style.height = el.height + 'px';
      }
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      markUnsaved();
      renderProperties();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function markUnsaved() {
    saveStatus.textContent = 'Unsaved changes';
  }

  function propRow(labelText, inputEl) {
    const row = document.createElement('div');
    row.className = 'name-tag-prop-row';
    const label = document.createElement('label');
    label.textContent = labelText;
    row.appendChild(label);
    row.appendChild(inputEl);
    return row;
  }

  function renderProperties() {
    propsPanel.innerHTML = '';
    const el = findEl(selectedId);
    if (!el) return;

    const title = document.createElement('h3');
    title.textContent =
      el.type === 'text' ? 'Text: ' + (fieldLabel(el.field) || el.field) : el.type === 'barcode' ? 'Barcode' : el.type === 'image' ? 'Image' : 'Shape';
    propsPanel.appendChild(title);

    if (el.type === 'text') {
      const fontSize = document.createElement('input');
      fontSize.type = 'number';
      fontSize.min = '8';
      fontSize.max = '72';
      fontSize.value = el.fontSize;
      fontSize.addEventListener('input', () => {
        el.fontSize = parseInt(fontSize.value, 10) || 12;
        renderCanvas();
        markUnsaved();
      });
      propsPanel.appendChild(propRow('Font size', fontSize));

      const color = document.createElement('input');
      color.type = 'color';
      color.value = el.color;
      color.addEventListener('input', () => {
        el.color = color.value;
        renderCanvas();
        markUnsaved();
      });
      propsPanel.appendChild(propRow('Color', color));

      const bold = document.createElement('input');
      bold.type = 'checkbox';
      bold.checked = !!el.bold;
      bold.addEventListener('change', () => {
        el.bold = bold.checked;
        renderCanvas();
        markUnsaved();
      });
      propsPanel.appendChild(propRow('Bold', bold));

      const align = document.createElement('select');
      ['left', 'center', 'right'].forEach((a) => {
        const opt = document.createElement('option');
        opt.value = a;
        opt.textContent = a.charAt(0).toUpperCase() + a.slice(1);
        if (el.align === a) opt.selected = true;
        align.appendChild(opt);
      });
      align.addEventListener('change', () => {
        el.align = align.value;
        renderCanvas();
        markUnsaved();
      });
      propsPanel.appendChild(propRow('Align', align));
    } else if (el.type === 'shape') {
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
        markUnsaved();
      });
      noFill.addEventListener('change', () => {
        fill.disabled = noFill.checked;
        el.fill = noFill.checked ? 'transparent' : fill.value;
        renderCanvas();
        markUnsaved();
      });
      propsPanel.appendChild(propRow('No fill', noFill));
      propsPanel.appendChild(propRow('Fill color', fill));

      const borderColor = document.createElement('input');
      borderColor.type = 'color';
      borderColor.value = el.borderColor && el.borderColor !== 'transparent' ? el.borderColor : '#000000';
      borderColor.addEventListener('input', () => {
        el.borderColor = borderColor.value;
        renderCanvas();
        markUnsaved();
      });
      propsPanel.appendChild(propRow('Border color', borderColor));

      const borderWidth = document.createElement('input');
      borderWidth.type = 'number';
      borderWidth.min = '0';
      borderWidth.max = '20';
      borderWidth.value = el.borderWidth || 0;
      borderWidth.addEventListener('input', () => {
        el.borderWidth = parseInt(borderWidth.value, 10) || 0;
        renderCanvas();
        markUnsaved();
      });
      propsPanel.appendChild(propRow('Border width', borderWidth));

      const borderRadius = document.createElement('input');
      borderRadius.type = 'number';
      borderRadius.min = '0';
      borderRadius.max = '200';
      borderRadius.value = el.borderRadius || 0;
      borderRadius.addEventListener('input', () => {
        el.borderRadius = parseInt(borderRadius.value, 10) || 0;
        renderCanvas();
        markUnsaved();
      });
      propsPanel.appendChild(propRow('Corner radius', borderRadius));
    } else if (el.type === 'image') {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'Drag to move, use the corner handle to resize.';
      propsPanel.appendChild(p);
    } else if (el.type === 'barcode') {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = "Shows each member's real barcode when printed.";
      propsPanel.appendChild(p);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn-secondary name-tag-delete-btn';
    deleteBtn.textContent = 'Delete Element';
    deleteBtn.addEventListener('click', () => {
      const idx = currentLayout().findIndex((e) => e.id === el.id);
      if (idx >= 0) currentLayout().splice(idx, 1);
      selectedId = null;
      renderCanvas();
      renderProperties();
      markUnsaved();
    });
    propsPanel.appendChild(deleteBtn);
  }

  function fieldLabel(field) {
    const found = (FIELDS_BY_TYPE[currentType] || []).find((f) => f.field === field);
    return found ? found.label : null;
  }

  function addField(field) {
    currentLayout().push({
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
    });
    renderCanvas();
    markUnsaved();
  }

  function addShape() {
    currentLayout().push({
      id: newId('shape'),
      type: 'shape',
      x: 20,
      y: 20,
      width: 120,
      height: 60,
      fill: 'transparent',
      borderColor: '#1c2530',
      borderWidth: 2,
      borderRadius: 0,
    });
    renderCanvas();
    markUnsaved();
  }

  function addBarcode() {
    currentLayout().push({ id: newId('barcode'), type: 'barcode', x: 43, y: 150, width: 250, height: 55 });
    renderCanvas();
    markUnsaved();
  }

  async function uploadImage(file) {
    const formData = new FormData();
    formData.append('image', file);
    try {
      const res = await fetch('/admin/name-tag/design-image', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.ok) {
        currentLayout().push({ id: newId('image'), type: 'image', src: data.url, x: 10, y: 10, width: 100, height: 100 });
        renderCanvas();
        markUnsaved();
      } else {
        alert(data.message || 'Could not upload that image.');
      }
    } catch (err) {
      alert('Connection error uploading image.');
    }
  }

  // The toolbar is a single "Choose a tool..." dropdown - picking an option
  // reveals just that tool's controls in the small panel below it, instead
  // of a permanent row of five buttons.
  function renderToolPanel() {
    const tool = toolSelect.value;
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
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-secondary';
      btn.textContent = '+ Add to Badge';
      btn.addEventListener('click', () => addField(select.value));
      row.appendChild(select);
      row.appendChild(btn);
      toolPanel.appendChild(row);
    } else if (tool === 'add-shape') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-secondary';
      btn.textContent = '+ Add Shape to Badge';
      btn.addEventListener('click', addShape);
      toolPanel.appendChild(btn);
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
      const label = document.createElement('label');
      label.className = 'name-tag-bg-label';
      label.textContent = 'Background Color';
      const input = document.createElement('input');
      input.type = 'color';
      input.value = currentTemplate().background || '#ffffff';
      input.addEventListener('input', () => {
        currentTemplate().background = input.value;
        canvas.style.background = input.value;
        markUnsaved();
      });
      label.appendChild(input);
      toolPanel.appendChild(label);
    }
  }

  function switchType(type) {
    currentType = type;
    selectedId = null;
    typeSelect.value = type;
    toolSelect.value = '';
    renderToolPanel();
    renderCanvas();
    renderProperties();
    saveStatus.textContent = '';
  }

  // The design editor's canvas/tool-select/etc. only exist on the Design
  // tab - Print/Requests/Archived render a different tab panel entirely.
  if (canvas) {
    canvas.style.width = BADGE_WIDTH + 'px';
    canvas.style.height = BADGE_HEIGHT + 'px';

    typeSelect.addEventListener('change', () => switchType(typeSelect.value));
    toolSelect.addEventListener('change', renderToolPanel);

    document.getElementById('reset-template-btn').addEventListener('click', () => {
      if (!confirm('Reset the ' + currentType + ' badge design to the default layout? This discards unsaved changes.')) return;
      layouts[currentType] = cloneLayout(DEFAULT_LAYOUTS[currentType]);
      selectedId = null;
      renderCanvas();
      renderProperties();
      markUnsaved();
    });

    document.getElementById('save-template-btn').addEventListener('click', async () => {
      saveStatus.textContent = 'Saving…';
      try {
        const res = await fetch('/admin/name-tag/template/' + currentType, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ layout: currentTemplate() }),
        });
        const data = await res.json();
        saveStatus.textContent = data.ok ? 'Saved!' : 'Could not save.';
      } catch (err) {
        saveStatus.textContent = 'Connection error.';
      }
    });

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

    // A single "Select All Shown" checkbox toggles every currently-visible
    // row's checkbox to match it, instead of separate Select All/Select None
    // buttons.
    const selectAllCheckbox = document.getElementById('name-tag-select-all-checkbox');
    if (selectAllCheckbox) {
      selectAllCheckbox.addEventListener('change', () => {
        bulkList.querySelectorAll('.member-picker-row').forEach((row) => {
          if (row.style.display !== 'none') row.querySelector('input[type="checkbox"]').checked = selectAllCheckbox.checked;
        });
      });
    }
  }
})();
