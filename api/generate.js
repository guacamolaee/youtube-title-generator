const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;

function extractJson(html, marker) {
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  let start = idx + marker.length;
  while (start < html.length && html[start] !== '{') start++;
  if (start >= html.length) return null;
  let depth = 0, end = -1;
  for (let i = start; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  try { return JSON.parse(html.slice(start, end + 1)); } catch { return null; }
}

const YT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

async function getPlayerResponse(videoId) {
  // Try InnerTube API first
  try {
    const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': YT_HEADERS['User-Agent'],
        'Origin': 'https://www.youtube.com',
        'Referer': 'https://www.youtube.com/',
      },
      body: JSON.stringify({
        videoId,
        context: { client: { hl: 'en', gl: 'US', clientName: 'WEB', clientVersion: '2.20231121.08.00' } },
      }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.videoDetails) return data;
    }
  } catch (_) {}

  // Fallback: scrape watch page
  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en&gl=US`, { headers: YT_HEADERS });
  if (!pageRes.ok) throw new Error(`YouTube page returned ${pageRes.status}`);
  const html = await pageRes.text();
  for (const m of ['ytInitialPlayerResponse = ', 'var ytInitialPlayerResponse = ', 'ytInitialPlayerResponse=']) {
    const r = extractJson(html, m);
    if (r && r.videoDetails) return r;
  }
  throw new Error('Could not parse video info from YouTube.');
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const { videoId } = body;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid video ID.' });
  }

  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_KEY environment variable not set.' });
  }

  // 1. Get player response
  let playerResponse;
  try {
    playerResponse = await getPlayerResponse(videoId);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }

  // 2. Pick caption track
  const tracks = (playerResponse.captions &&
    playerResponse.captions.playerCaptionsTracklistRenderer &&
    playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
  if (!tracks.length) return res.status(404).json({ error: 'No captions found for this video.' });

  const track =
    tracks.find(t => t.languageCode === 'en' && !(t.kind && t.kind.includes('asr'))) ||
    tracks.find(t => t.languageCode === 'en') ||
    tracks.find(t => t.languageCode && t.languageCode.startsWith('en')) ||
    tracks[0];

  // 3. Fetch transcript
  const capRes = await fetch(track.baseUrl + '&fmt=json3', { headers: YT_HEADERS });
  if (!capRes.ok) return res.status(502).json({ error: 'Failed to fetch transcript.' });
  const capData = await capRes.json();
  if (!capData || !capData.events) return res.status(502).json({ error: 'Transcript data is empty.' });

  const transcript = capData.events
    .filter(e => e.segs)
    .flatMap(e => e.segs.map(s => s.utf8 || ''))
    .join(' ').replace(/\s+/g, ' ').trim();

  if (transcript.length < 50) return res.status(422).json({ error: 'Transcript is too short.' });

  // 4. Call Anthropic
  const videoTitle  = (playerResponse.videoDetails && playerResponse.videoDetails.title)  || '';
  const channelName = (playerResponse.videoDetails && playerResponse.videoDetails.author) || '';
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
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 512, messages: [{ role: 'user', content: prompt }] }),
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
