(function () {
  const inputs = document.querySelectorAll('.volunteer-cell-input[data-field]');
  if (!inputs.length) return;

  const status = document.getElementById('volunteer-save-status');

  inputs.forEach((input) => {
    let lastValue = input.value;
    input.addEventListener('blur', async () => {
      if (input.value === lastValue) return;
      lastValue = input.value;

      const day = input.dataset.day;
      const key = input.dataset.field + ':' + input.dataset.member + ':' + input.dataset.date;
      const body = new URLSearchParams();
      body.set(key, input.value);

      if (status) status.textContent = 'Saving…';
      try {
        await fetch('/admin/volunteers/' + day + '/assignments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });
        if (status) status.textContent = 'Saved';
      } catch (err) {
        if (status) status.textContent = 'Connection error saving.';
      }
    });
  });
})();
