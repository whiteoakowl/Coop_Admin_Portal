// Real bug report: pasting a YouTube link into a Training video lesson's
// Video URL field rendered a black, non-playing box - a plain <video src>
// can only ever load a direct video file, never a YouTube page. Fixes
// utils/training.js's youtubeVideoId - the pure URL-parsing function
// training-play.ejs/routes/training.js use to decide whether to render a
// real YouTube embed instead. Covers every URL shape someone is
// realistically going to paste (watch pages with/without extra query
// params, youtu.be, embed/shorts links, the nocookie domain, www./m.
// prefixes, no-scheme input) and confirms it stays null for anything
// that genuinely isn't a YouTube link (a direct video file, garbage
// input, empty/missing).
const test = require('node:test');
const assert = require('node:assert/strict');
const { youtubeVideoId } = require('../utils/training');

const REAL_ID = 'dQw4w9WgXcQ';

test('youtubeVideoId recognizes every real-world YouTube URL shape', () => {
  const shapes = [
    `https://www.youtube.com/watch?v=${REAL_ID}`,
    `https://youtube.com/watch?v=${REAL_ID}`,
    `http://www.youtube.com/watch?v=${REAL_ID}`,
    `https://m.youtube.com/watch?v=${REAL_ID}`,
    // A playlist link where v= isn't the first query param.
    `https://www.youtube.com/watch?list=PLxyz&v=${REAL_ID}&index=3`,
    // A timestamped link.
    `https://www.youtube.com/watch?v=${REAL_ID}&t=42s`,
    `https://youtu.be/${REAL_ID}`,
    `https://youtu.be/${REAL_ID}?t=10`,
    `https://www.youtube.com/embed/${REAL_ID}`,
    `https://www.youtube.com/shorts/${REAL_ID}`,
    `https://www.youtube-nocookie.com/embed/${REAL_ID}`,
    // Pasted without a leading scheme - a real, common way to copy a URL
    // straight out of an address bar.
    `www.youtube.com/watch?v=${REAL_ID}`,
    `youtu.be/${REAL_ID}`,
  ];
  for (const url of shapes) {
    assert.equal(youtubeVideoId(url), REAL_ID, `expected to extract the video id from: ${url}`);
  }
});

test('youtubeVideoId returns null for anything that is not a real YouTube link', () => {
  const notYouTube = [
    null,
    undefined,
    '',
    'https://example.com/video.mp4',
    'https://vimeo.com/123456789',
    'https://www.youtube.com/', // no video id anywhere
    'https://www.youtube.com/watch', // no ?v= at all
    'https://www.youtube.com/channel/UC12345', // a channel page, not a video
    'not a url at all',
    'https://www.youtube.com/watch?v=tooshort',
  ];
  for (const url of notYouTube) {
    assert.equal(youtubeVideoId(url), null, `expected null for: ${url}`);
  }
});
