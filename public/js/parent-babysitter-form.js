// Parent Portal's Babysitter Directory: one combined Add/Edit Babysitters
// dialog instead of a separate accordion form per child (see
// views/parent-babysitters.ejs's own comment). Repopulates the form's
// fields with the selected child's existing profile - if any - straight
// from the JSON already embedded server-side, no reload/AJAX needed.
(function () {
  const select = document.getElementById('babysitter-student-select');
  const dataScript = document.getElementById('babysitter-profile-data');
  if (!select || !dataScript) return;
  const profileByChildId = JSON.parse(dataScript.textContent || '{}');

  const FIELDS = {
    ageGrade: 'age_grade',
    availability: 'availability',
    experience: 'experience',
    certifications: 'certifications',
    hourlyRate: 'hourly_rate',
    contactMethod: 'contact_method',
  };

  function fillForSelectedStudent() {
    const profile = profileByChildId[select.value] || null;
    for (const [fieldName, column] of Object.entries(FIELDS)) {
      const el = document.getElementById('babysitter-field-' + fieldName);
      if (el) el.value = profile ? profile[column] || '' : '';
    }
  }

  select.addEventListener('change', fillForSelectedStudent);
  fillForSelectedStudent();
})();
