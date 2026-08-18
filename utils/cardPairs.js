// Builds the { name, nameTag: {html, bgCss}, scheduleCard: {html, bgCss} }
// shape every "Name Tag + Schedule Card" print flow needs (side-by-side,
// front-and-back duplex, and the per-member Cards dialog's own versions of
// each) - a small shared module rather than a route-file export so none of
// the routes that need it (routes/admin-design.js for bulk printing,
// routes/admin-members.js for the per-member Cards dialog) have to import
// from one another.
const { getTemplate, badgeDataForMembers } = require('./nameTagData');
const { getScheduleCardTemplate, scheduleCardDataForMembers } = require('./scheduleCardData');
const { schedulesForMembers } = require('./schedule');
const NameTagRenderCore = require('../public/js/name-tag-render-core');

async function buildCardPairs(members) {
  const nameTagTemplates = { student: await getTemplate('student'), parent: await getTemplate('parent'), admin: await getTemplate('admin') };
  const scheduleCardTemplate = await getScheduleCardTemplate();
  const scheduleCardBgCss = NameTagRenderCore.backgroundCss(scheduleCardTemplate.background, scheduleCardTemplate.backgroundOpacity);

  // All computed once for this whole batch, not once per member - a real
  // bug report: printing ~800 cards timed out, the same severe N+1 shape
  // already fixed for the Schedule-Card-only bulk print (routes/admin-
  // schedule.js's print-cards route) and for Attendance's Arrival/
  // Departure (utils/schedule.js's arrivalDepartureLabelsForMembers), just
  // never applied here. See badgeDataForMembers/schedulesForMembers/
  // scheduleCardDataForMembers' own comments.
  const memberIds = members.map((m) => m.id);
  const [nameTagDataByMember, scheduleByMember] = await Promise.all([badgeDataForMembers(members), schedulesForMembers(memberIds)]);
  const scheduleCardDataByMember = await scheduleCardDataForMembers(members, scheduleByMember);

  return members.map((m) => {
    const nameTagLayout = nameTagTemplates[m.member_type] || nameTagTemplates.student;
    return {
      name: m.name,
      nameTag: {
        html: NameTagRenderCore.renderBadgeElements(nameTagLayout.elements, nameTagDataByMember[m.id]),
        bgCss: NameTagRenderCore.backgroundCss(nameTagLayout.background, nameTagLayout.backgroundOpacity),
      },
      scheduleCard: {
        html: NameTagRenderCore.renderBadgeElements(scheduleCardTemplate.elements, scheduleCardDataByMember[m.id]),
        bgCss: scheduleCardBgCss,
      },
    };
  });
}

module.exports = { buildCardPairs };
