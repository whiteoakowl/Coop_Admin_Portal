(function () {
  const memberForm = document.getElementById('library-member-form');
  if (!memberForm) return; // not the Checkout tab

  const memberInput = document.getElementById('library-member-input');
  const memberHint = document.getElementById('library-member-hint');
  const memberDisplay = document.getElementById('library-member-display');

  const itemForm = document.getElementById('library-item-form');
  const itemInput = document.getElementById('library-item-input');
  const itemHint = document.getElementById('library-item-hint');

  const pendingTable = document.getElementById('library-pending-table');
  const pendingTbody = document.getElementById('library-pending-tbody');
  const pendingEmpty = document.getElementById('library-pending-empty');
  const clearBtn = document.getElementById('library-clear-btn');
  const saveBtn = document.getElementById('library-save-btn');

  const checkoutForm = document.getElementById('library-checkout-form');
  const checkoutMemberId = document.getElementById('library-checkout-member-id');
  const checkoutItemInputs = document.getElementById('library-checkout-item-inputs');

  let currentMember = null;
  let pendingItems = [];

  function renderPending() {
    pendingTbody.innerHTML = '';
    if (pendingItems.length === 0) {
      pendingTable.hidden = true;
      pendingEmpty.hidden = false;
    } else {
      pendingTable.hidden = false;
      pendingEmpty.hidden = true;
      pendingItems.forEach((item, index) => {
        const tr = document.createElement('tr');
        const titleTd = document.createElement('td');
        titleTd.textContent = item.title;
        const actionTd = document.createElement('td');
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn-secondary';
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', () => {
          pendingItems.splice(index, 1);
          renderPending();
        });
        actionTd.appendChild(removeBtn);
        tr.appendChild(titleTd);
        tr.appendChild(actionTd);
        pendingTbody.appendChild(tr);
      });
    }
    saveBtn.disabled = !currentMember || pendingItems.length === 0;
  }

  function resetAll() {
    currentMember = null;
    pendingItems = [];
    memberDisplay.hidden = true;
    memberHint.hidden = false;
    itemInput.disabled = true;
    itemInput.value = '';
    itemHint.textContent = 'Scan a member first, then scan each item being checked out.';
    memberInput.value = '';
    renderPending();
    memberInput.focus();
  }

  memberForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const barcode = memberInput.value.trim();
    memberInput.value = '';
    if (!barcode) return;

    try {
      const res = await fetch('/admin/library/scan-member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'barcode=' + encodeURIComponent(barcode),
      });
      const data = await res.json();
      if (data.ok) {
        currentMember = data.member;
        memberDisplay.textContent = 'Checking out for: ' + data.member.name;
        memberDisplay.hidden = false;
        memberHint.hidden = true;
        itemInput.disabled = false;
        itemHint.textContent = 'Scan each item being checked out.';
        itemInput.focus();
      } else {
        memberHint.hidden = false;
        memberHint.textContent = data.message;
      }
    } catch (err) {
      memberHint.hidden = false;
      memberHint.textContent = 'Connection error. Please try again.';
    }
    renderPending();
  });

  itemForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const barcode = itemInput.value.trim();
    itemInput.value = '';
    if (!barcode || !currentMember) return;

    try {
      const res = await fetch('/admin/library/scan-item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'barcode=' + encodeURIComponent(barcode),
      });
      const data = await res.json();
      if (data.ok) {
        if (!pendingItems.some((i) => i.id === data.item.id)) {
          pendingItems.push(data.item);
        }
        itemHint.textContent = 'Scan each item being checked out.';
      } else {
        itemHint.textContent = data.message;
      }
    } catch (err) {
      itemHint.textContent = 'Connection error. Please try again.';
    }
    renderPending();
    itemInput.focus();
  });

  clearBtn.addEventListener('click', resetAll);

  saveBtn.addEventListener('click', () => {
    if (!currentMember || pendingItems.length === 0) return;
    checkoutMemberId.value = currentMember.id;
    checkoutItemInputs.innerHTML = '';
    pendingItems.forEach((item) => {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'itemIds';
      input.value = item.id;
      checkoutItemInputs.appendChild(input);
    });
    checkoutForm.submit();
  });

  renderPending();
  memberInput.focus();
})();
