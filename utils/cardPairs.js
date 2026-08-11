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

async function buildCardPairs(members) {
  const nameTagTemplates = { student: await getTemplate('student'), parent: await getTemplate('parent') };
  const scheduleCardTemplate = await getScheduleCardTemplate();
  const scheduleCardBgCss = NameTagRenderCore.backgroundCss(scheduleCardTemplate.background, scheduleCardTemplate.backgroundOpacity);

  const pairs = [];
  for (const m of members) {
    const nameTagLayout = nameTagTemplates[m.member_type] || nameTagTemplates.student;
    pairs.push({
      name: m.name,
      nameTag: {
        html: NameTagRenderCore.renderBadgeElements(nameTagLayout.elements, await badgeDataForMember(m)),
        bgCss: NameTagRenderCore.backgroundCss(nameTagLayout.background, nameTagLayout.backgroundOpacity),
      },
      scheduleCard: {
        html: NameTagRenderCore.renderBadgeElements(scheduleCardTemplate.elements, await scheduleCardDataForMember(m)),
        bgCss: scheduleCardBgCss,
      },
    });
  }
  return pairs;
}

module.exports = { buildCardPairs };
