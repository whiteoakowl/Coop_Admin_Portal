// Training Player (views/training-play.ejs). Two jobs:
//
// 1. Mark the currently-viewed lesson "in progress" the moment its panel
//    loads (a plain fetch POST, fire-and-forget - the server itself
//    already refuses this for a locked lesson, so there's nothing this
//    script needs to check first).
//
// 2. For a video lesson: real <video> playback progress, reported to the
//    server periodically via timeupdate (throttled - no need to POST on
//    every single frame) and once more on pause/ended. The server is the
//    only thing that decides whether the required watch threshold has
//    been reached (utils/training.js's recordVideoProgress) - this
//    script just reports honestly what the player observed and reflects
//    the server's own answer back (enabling the Complete button, and
//    updating the watched-percent line), never enables the button itself
//    based on a percentage it computed locally.
(function () {
  const video = document.getElementById('training-video');
  if (video) {
    const aId = video.dataset.assignmentId;
    const lId = video.dataset.lessonId;
    const resume = parseFloat(video.dataset.resumeSeconds) || 0;
    const percentLabel = document.getElementById('training-video-percent');
    const completeBtn = document.getElementById('training-complete-btn');

    video.addEventListener('loadedmetadata', () => {
      if (resume > 0 && resume < video.duration) video.currentTime = resume;
    });

    let lastReported = 0;
    function reportProgress() {
      const current = video.currentTime;
      if (Math.abs(current - lastReported) < 2 && current < video.duration - 0.5) return; // throttle to ~every 2s of playback, always send the final position
      lastReported = current;
      fetch(`/training/${aId}/lessons/${lId}/video-progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentSeconds: current, durationSeconds: video.duration || 0 }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (!data.ok) return;
          if (percentLabel) percentLabel.textContent = `Watched: ${data.percent}%`;
          if (data.completed && completeBtn) {
            completeBtn.disabled = false;
            completeBtn.textContent = 'Mark Complete & Continue';
          }
        })
        .catch(() => {});
    }

    video.addEventListener('timeupdate', reportProgress);
    video.addEventListener('pause', reportProgress);
    video.addEventListener('ended', reportProgress);
  }

  // Mark the lesson "in progress" as soon as its panel is viewed - a
  // plain <video>/text/quiz view all count, not just video playback.
  // Lesson id is read off whichever action URL is actually on the page
  // (the complete form or the quiz form, or the video element itself)
  // rather than a separate data attribute, since one of those is always
  // present for any unlocked, uncompleted lesson.
  const actionForm = document.querySelector('#training-complete-form, .training-quiz-form');
  const actionUrl = actionForm ? actionForm.getAttribute('action') : video ? `/training/${video.dataset.assignmentId}/lessons/${video.dataset.lessonId}/start` : null;
  const match = actionUrl && /\/training\/(\d+)\/lessons\/(\d+)\//.exec(actionUrl);
  if (match) {
    fetch(`/training/${match[1]}/lessons/${match[2]}/start`, { method: 'POST' }).catch(() => {});
  }
})();
