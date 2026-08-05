(function () {
  const searchInput = document.getElementById('schedule-search-input');
  if (!searchInput) return;

  let timer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const url = new URL(window.location.href);
      if (searchInput.value) url.searchParams.set('search', searchInput.value);
      else url.searchParams.delete('search');
      url.searchParams.delete('page');
      window.location = url.toString();
    }, 500);
  });
})();
