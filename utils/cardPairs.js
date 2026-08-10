// Builds the { name, nameTag: {html, bgCss}, scheduleCard: {html, bgCss} }
// shape every "Name Tag + Schedule Card" print flow needs (side-by-side,
// front-and-back duplex, and the per-member Cards dialog's own versions of
// each) - a small shared module rather than a route-file export so none of
// the routes that need it (routes/admin-design.js for bulk printing,
// routes/admin-members.js for the per-member Cards dialog) have to import
// from one another.
const { getTemplate, badgeDataForMember } = require('./nameTagData');
const { getScheduleCardTemplate, scheduleCardDataForMember } = require('./scheduleCardData');
const NameTagRenderCore = require('../public/js/name-tag-render-core');

function buildCardPairs(members) {
  const nameTagTemplates = { student: getTemplate('student'), parent: getTemplate('parent') };
  const scheduleCardTemplate = getScheduleCardTemplate();
  const scheduleCardBgCss = NameTagRenderCore.backgroundCss(scheduleCardTemplate.background, scheduleCardTemplate.backgroundOpacity);

  return members.map((m) => {
    const nameTagLayout = nameTagTemplates[m.member_type] || nameTagTemplates.student;
    return {
      name: m.name,
      nameTag: {
        html: NameTagRenderCore.renderBadgeElements(nameTagLayout.elements, badgeDataForMember(m)),
        bgCss: NameTagRenderCore.backgroundCss(nameTagLayout.background, nameTagLayout.backgroundOpacity),
      },
      scheduleCard: {
        html: NameTagRenderCore.renderBadgeElements(scheduleCardTemplate.elements, scheduleCardDataForMember(m)),
        bgCss: scheduleCardBgCss,
      },
    };
  });
}

module.exports = { buildCardPairs };
