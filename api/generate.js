const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;

async function getTranscript(videoId) {
  // Use Android client — bypasses YouTube's bot detection for server IPs
  const playerRes = await fetch(
    'https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'com.google.android.youtube/17.36.4 (Linux; U; Android 12; GB) gzip',
        'X-YouTube-Client-Name': '3',
        'X-YouTube-Client-Version': '17.36.4',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            hl: 'en',
            gl: 'US',
            clientName: 'ANDROID',
            clientVersion: '17.36.4',
            androidSdkVersion: 31,
            userAgent: 'com.google.android.youtube/17.36.4 (Linux; U; Android 12; GB) gzip',
            osName: 'Android',
            osVersion: '12',
          },
        },
      }),
    }
  );

  if (!playerRes.ok) throw new Error(`YouTube returned ${playerRes.status}`);
  const player = await playerRes.json();

  const videoTitle  = player?.videoDetails?.title  || '';
  const channelName = player?.videoDetails?.author || '';

  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) throw new Error('No captions found for this video.');

  const track =
    tracks.find(t => t.languageCode === 'en' && !(t.kind || '').includes('asr')) ||
    tracks.find(t => t.languageCode === 'en') ||
    tracks.find(t => (t.languageCode || '').startsWith('en')) ||
    tracks[0];

  const capRes = await fetch(track.baseUrl + '&fmt=json3');
  if (!capRes.ok) throw new Error('Failed to fetch captions.');
  const capData = await capRes.json();

  const transcript = (capData.events || [])
    .filter(e => e.segs)
    .flatMap(e => e.segs.map(s => s.utf8 || ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (transcript.length < 50) throw new Error('Transcript is too short.');

  return { transcript, videoTitle, channelName };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { videoId } = req.body || {};
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid video ID.' });
  }

  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_KEY environment variable not set.' });
  }

  let transcript, videoTitle, channelName;
  try {
    ({ transcript, videoTitle, channelName } = await getTranscript(videoId));
  } catch (e) {
    return res.status(404).json({ error: e.message });
  }

  const hint = [
    videoTitle  ? `The current video title is: "${videoTitle}"` : '',
    channelName ? `The channel is: "${channelName}"`            : '',
  ].filter(Boolean).join('\n');

  const prompt = `You are a YouTube title optimization expert. ${hint}
Based on the following video transcript, generate exactly 5 optimized YouTube title suggestions.

Guidelines:
- Use proven hooks: numbers, questions, curiosity gaps, "How I", "Why You", etc.
- Include power words that drive clicks (Secret, Never, Always, Shocking, Proven, etc.)
- Keep each title under 70 characters when possible
- Reflect the actual content and key insights from the transcript
- Balance SEO keywords with emotional appeal
- Vary the style across the 5 suggestions

Transcript:
${transcript.slice(0, 6000)}

Output ONLY the 5 titles, one per line, numbered 1 through 5. No explanations, no extra text.`;

  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!aiRes.ok) return res.status(502).json({ error: `Anthropic API error (${aiRes.status}).` });
  const aiData = await aiRes.json();
  if (aiData.error) return res.status(502).json({ error: 'Anthropic: ' + aiData.error.message });

  const raw = (aiData.content && aiData.content[0] && aiData.content[0].text) || '';
  const titles = raw.split('\n')
    .map(l => l.replace(/^\d+[\.\)]\s*/, '').trim())
    .filter(l => l.length > 4)
    .slice(0, 5);

  res.status(200).json({ titles, videoTitle, channelName });
};
