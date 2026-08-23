// Training Player (views/training-play.ejs). Two jobs:
//
// 1. Mark the currently-viewed lesson "in progress" the moment its panel
//    loads (a plain fetch POST, fire-and-forget - the server itself
//    already refuses this for a locked lesson, so there's nothing this
//    script needs to check first).
//
// 2. For a video lesson: real playback progress, reported to the server
//    periodically and once more on pause/ended. The server is the only
//    thing that decides whether the required watch threshold has been
//    reached (utils/training.js's recordVideoProgress) - this script
//    just reports honestly what the player observed and reflects the
//    server's own answer back (enabling the Complete button, and
//    updating the watched-percent line), never enables the button itself
//    based on a percentage it computed locally. Two real players share
//    this one reporting path: a native <video> element (#training-video,
//    a direct file URL) via its own timeupdate/pause/ended events, and a
//    YouTube embed (#training-youtube-player, a pasted youtube.com/
//    youtu.be link - see utils/training.js's youtubeVideoId) via the
//    YouTube IFrame Player API's onStateChange, since a cross-origin
//    iframe has no native <video> events of its own to observe - this
//    polls getCurrentTime()/getDuration() on an interval while playing
//    instead.
(function () {
  const nativeVideo = document.getElementById('training-video');
  const youtubeEl = document.getElementById('training-youtube-player');
  const target = nativeVideo || youtubeEl;

  if (target) {
    const aId = target.dataset.assignmentId;
    const lId = target.dataset.lessonId;
    const resume = parseFloat(target.dataset.resumeSeconds) || 0;
    const percentLabel = document.getElementById('training-video-percent');
    const completeBtn = document.getElementById('training-complete-btn');

    let lastReported = 0;
    function reportProgress(current, duration) {
      // Throttle to ~every 2s of playback, but always send the final
      // position even if it lands inside that window (duration falsy
      // just means "not known yet" - never withhold a report over that).
      if (Math.abs(current - lastReported) < 2 && duration && current < duration - 0.5) return;
      lastReported = current;
      fetch(`/training/${aId}/lessons/${lId}/video-progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentSeconds: current, durationSeconds: duration || 0 }),
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

    if (nativeVideo) {
      nativeVideo.addEventListener('loadedmetadata', () => {
        if (resume > 0 && resume < nativeVideo.duration) nativeVideo.currentTime = resume;
      });
      nativeVideo.addEventListener('timeupdate', () => reportProgress(nativeVideo.currentTime, nativeVideo.duration));
      nativeVideo.addEventListener('pause', () => reportProgress(nativeVideo.currentTime, nativeVideo.duration));
      nativeVideo.addEventListener('ended', () => reportProgress(nativeVideo.currentTime, nativeVideo.duration));
    } else if (youtubeEl) {
      // The IFrame API loads asynchronously and calls this exact global
      // once it's ready - its own fixed contract, not something this app
      // gets to rename even though nothing else here also embeds YouTube.
      window.onYouTubeIframeAPIReady = function () {
        let pollTimer = null;
        function stopPolling() {
          if (pollTimer) clearInterval(pollTimer);
          pollTimer = null;
        }
        const player = new window.YT.Player(youtubeEl.id, {
          videoId: youtubeEl.dataset.videoId,
          playerVars: { rel: 0 },
          events: {
            onReady: () => {
              if (resume > 0) player.seekTo(resume, true);
            },
            onStateChange: (e) => {
              stopPolling();
              const State = window.YT.PlayerState;
              if (e.data === State.PLAYING) {
                pollTimer = setInterval(() => reportProgress(player.getCurrentTime(), player.getDuration()), 2000);
              } else if (e.data === State.PAUSED || e.data === State.ENDED) {
                reportProgress(player.getCurrentTime(), player.getDuration());
              }
            },
          },
        });
      };

      const apiScript = document.createElement('script');
      apiScript.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(apiScript);
    }
  }

  // Mark the lesson "in progress" as soon as its panel is viewed - a
  // plain <video>/YouTube/text/quiz view all count, not just video
  // playback. Lesson id is read off whichever action URL is actually on
  // the page (the complete form or the quiz form, or the video/YouTube
  // element itself) rather than a separate data attribute, since one of
  // those is always present for any unlocked, uncompleted lesson.
  const actionForm = document.querySelector('#training-complete-form, .training-quiz-form');
  const actionUrl = actionForm ? actionForm.getAttribute('action') : target ? `/training/${target.dataset.assignmentId}/lessons/${target.dataset.lessonId}/start` : null;
  const match = actionUrl && /\/training\/(\d+)\/lessons\/(\d+)\//.exec(actionUrl);
  if (match) {
    fetch(`/training/${match[1]}/lessons/${match[2]}/start`, { method: 'POST' }).catch(() => {});
  }
})();
