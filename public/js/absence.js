(function () {
  const form = document.getElementById('absence-form');
  const dateInput = document.getElementById('sessionDate');
  const warning = document.getElementById('date-warning');
  if (!form || !dateInput) return;

  function checkDate() {
    if (!dateInput.value) {
      warning.textContent = '';
      return true;
    }
    const [y, m, d] = dateInput.value.split('-').map(Number);
    const weekday = new Date(y, m - 1, d).getDay();
    if (weekday !== 1 && weekday !== 3) {
      warning.textContent = 'Please choose a Monday or Wednesday.';
      return false;
    }
    warning.textContent = '';
    return true;
  }

  dateInput.addEventListener('change', checkDate);

  form.addEventListener('submit', (e) => {
    if (!checkDate()) {
      e.preventDefault();
    }
  });
})();
