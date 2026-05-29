const express = require('express');
const cors = require('cors');
const ytDlp = require('youtube-dl-exec');

const app = express();
app.use(cors());

app.get('/api/audio', (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) return res.status(400).send('No URL provided');

  console.log(`[Backend] Fetching audio stream for: ${videoUrl}`);

  try {
    // We request the best audio format and pipe it directly to the response
    const ytDlpProcess = ytDlp.exec(videoUrl, {
      format: 'bestaudio',
      output: '-', // stdout
      noCheckCertificates: true,
      noWarnings: true
    });

    // We let the browser organically decode the container stream (webm/mp4 audio)
    res.setHeader('Content-Type', 'audio/webm');
    res.setHeader('Transfer-Encoding', 'chunked');

    ytDlpProcess.stdout.pipe(res);

    ytDlpProcess.on('error', (err) => {
      console.error('[Backend] yt-dlp stream error:', err.message);
      if (!res.headersSent) res.status(500).send('Error extracting audio stream');
    });
  } catch (err) {
    console.error('[Backend] Setup error:', err);
    if (!res.headersSent) res.status(500).send('Failed to process URL');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`===========================================`);
  console.log(`ClipFlow Audio Backend running on port ${PORT}`);
  console.log(`Ready to extract audio from TikTok & YouTube!`);
  console.log(`===========================================`);
});
