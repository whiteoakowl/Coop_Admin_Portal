// Transcripts: Add Class dialog - a real request: "Add class should
// have dropdown or year choices. Choose year and semester, then it
// will have three buttons saying, add co-op class, add family class,
// add manual class. If choosing co-op class it will then show a list
// of that students co-op classes for that school year. Choose family
// class and it will show you the family classes that were assigned to
// that student to choose from. Manual class allows you to add class
// name, credits and grade." Each of the three paths just ends up
// filling the one shared hidden className input the form actually
// submits (same "quick-fill the real field" idea the old quick-fill
// selects already used), gated behind picking a path first.
(function () {
  document.querySelectorAll('[data-transcript-add-form]').forEach((form) => {
    const dataScript = form.querySelector('[data-transcript-coop-data]');
    let coopClassesBySemester = {};
    try {
      coopClassesBySemester = JSON.parse(dataScript ? dataScript.textContent : '{}');
    } catch (err) {
      coopClassesBySemester = {};
    }

    const semesterSelect = form.querySelector('[data-transcript-semester-select]');
    const coopSelect = form.querySelector('[data-transcript-coop-select]');
    const familySelect = form.querySelector('[data-transcript-family-select]');
    const manualInput = form.querySelector('[data-transcript-manual-input]');
    const classNameInput = form.querySelector('[data-transcript-class-name]');
    const modeButtons = form.querySelectorAll('[data-transcript-mode]');
    const panels = form.querySelectorAll('[data-transcript-panel]');
    let activeMode = null;

    function showPanel(mode) {
      activeMode = mode;
      panels.forEach((panel) => {
        panel.hidden = panel.dataset.transcriptPanel !== mode;
      });
      classNameInput.value = '';
      if (mode === 'coop') populateCoopOptions();
    }

    // Built with DOM APIs (not innerHTML) so a class name containing
    // HTML-special characters can never be interpreted as markup.
    function setOptions(select, placeholder, names) {
      select.textContent = '';
      const placeholderOption = document.createElement('option');
      placeholderOption.value = '';
      placeholderOption.textContent = placeholder;
      select.appendChild(placeholderOption);
      names.forEach((name) => {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        select.appendChild(option);
      });
    }

    function populateCoopOptions() {
      if (!coopSelect) return;
      const semesterId = semesterSelect ? semesterSelect.value : '';
      const names = (semesterId && coopClassesBySemester[semesterId]) || [];
      if (!semesterId) {
        setOptions(coopSelect, '— choose a semester first —', []);
      } else if (names.length === 0) {
        setOptions(coopSelect, 'No co-op classes found for that semester', []);
      } else {
        setOptions(coopSelect, '— choose a co-op class —', names);
      }
      classNameInput.value = '';
    }

    modeButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        modeButtons.forEach((b) => b.classList.toggle('roster-action-btn-active', b === btn));
        showPanel(btn.dataset.transcriptMode);
      });
    });

    if (semesterSelect) {
      semesterSelect.addEventListener('change', () => {
        if (activeMode === 'coop') populateCoopOptions();
      });
    }
    if (coopSelect) coopSelect.addEventListener('change', () => { classNameInput.value = coopSelect.value; });
    if (familySelect) familySelect.addEventListener('change', () => { classNameInput.value = familySelect.value; });
    if (manualInput) manualInput.addEventListener('input', () => { classNameInput.value = manualInput.value; });
  });
})();
