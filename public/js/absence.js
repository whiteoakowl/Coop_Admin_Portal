(function () {
  const form = document.getElementById('absence-form');
  if (!form) return;

  const memberSelect = document.getElementById('memberId');
  const dateSelect = document.getElementById('sessionDate');
  const warning = document.getElementById('date-warning');

  async function loadDatesForMember(memberId, preselect) {
    dateSelect.innerHTML = '';
    warning.textContent = '';

    if (!memberId) {
      dateSelect.disabled = true;
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Select your name first…';
      dateSelect.appendChild(opt);
      return;
    }

    const loadingOpt = document.createElement('option');
    loadingOpt.value = '';
    loadingOpt.textContent = 'Loading…';
    dateSelect.appendChild(loadingOpt);
    dateSelect.disabled = true;

    try {
      const res = await fetch('/absence/dates?memberId=' + encodeURIComponent(memberId));
      const data = await res.json();
      dateSelect.innerHTML = '';

      if (!data.dates || data.dates.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No upcoming sessions found';
        dateSelect.appendChild(opt);
        dateSelect.disabled = true;
        warning.textContent = "This person isn't on any roster with upcoming dates.";
        return;
      }

      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Select a date…';
      dateSelect.appendChild(placeholder);

      data.dates.forEach((d) => {
        const opt = document.createElement('option');
        opt.value = d.date;
        opt.textContent = d.label;
        if (preselect && d.date === preselect) opt.selected = true;
        dateSelect.appendChild(opt);
      });
      dateSelect.disabled = false;
    } catch (err) {
      dateSelect.innerHTML = '';
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Could not load dates';
      dateSelect.appendChild(opt);
      warning.textContent = 'Connection error loading dates. Please try again.';
    }
  }

  memberSelect.addEventListener('change', () => loadDatesForMember(memberSelect.value, null));

  // Re-populate on load if the form is re-rendering after a failed submit.
  if (memberSelect.value) {
    loadDatesForMember(memberSelect.value, dateSelect.dataset.preselect || null);
  }

  if (form.dataset.redirectHome === '1') {
    setTimeout(() => {
      window.location.href = '/';
    }, 2000);
  }
})();
