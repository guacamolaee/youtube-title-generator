export const config = { runtime: 'edge' };

const YT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Cookie': 'CONSENT=YES+1',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function extractCaptionTracks(html) {
  const marker = '"captionTracks":';
  const idx = html.indexOf(marker);
  if (idx === -1) return null; // null = not found vs [] = found but empty
  let start = idx + marker.length;
  while (start < html.length && html[start] !== '[') start++;
  if (start >= html.length) return [];
  let depth = 0, end = -1;
  for (let i = start; i < html.length; i++) {
    if (html[i] === '[') depth++;
    else if (html[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return [];
  try { return JSON.parse(html.slice(start, end + 1)); } catch { return []; }
}

function extractVideoDetails(html) {
  const titleMatch = html.match(/"title":"([^"]+)"/);
  const authorMatch = html.match(/"author":"([^"]+)"/);
  return {
    videoTitle: titleMatch ? titleMatch[1].replace(/\\u[\dA-F]{4}/gi, c => String.fromCharCode(parseInt(c.replace(/\\u/, ''), 16))) : '',
    channelName: authorMatch ? authorMatch[1] : '',
  };
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 200 });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
  if (!ANTHROPIC_KEY) return json({ error: 'ANTHROPIC_KEY environment variable not set.' }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body.' }, 400); }

  const { videoId } = body || {};
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return json({ error: 'Invalid video ID.' }, 400);
  }

  // 1. Fetch YouTube watch page
  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en&gl=US`, {
    headers: YT_HEADERS,
  });
  if (!pageRes.ok) return json({ error: `YouTube returned ${pageRes.status}` }, 502);
  const html = await pageRes.text();

  // 2. Extract caption tracks
  const tracks = extractCaptionTracks(html);
  if (tracks === null) {
    // captionTracks key not found — likely got a bot-check page
    const isBot = html.includes('detected unusual traffic') || html.includes('confirm you') || html.includes('recaptcha');
    return json({ error: `YouTube served a ${isBot ? 'bot-check' : 'unexpected'} page (size: ${html.length} chars). Try again later.` }, 502);
  }
  if (!tracks.length) return json({ error: 'No captions found for this video.' }, 404);

  const track =
    tracks.find(t => t.languageCode === 'en' && !(t.kind || '').includes('asr')) ||
    tracks.find(t => t.languageCode === 'en') ||
    tracks.find(t => (t.languageCode || '').startsWith('en')) ||
    tracks[0];

  // 3. Fetch transcript
  const capRes = await fetch(track.baseUrl + '&fmt=json3');
  if (!capRes.ok) return json({ error: 'Failed to fetch captions.' }, 502);
  const capData = await capRes.json();

  const transcript = (capData.events || [])
    .filter(e => e.segs)
    .flatMap(e => e.segs.map(s => s.utf8 || ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (transcript.length < 50) return json({ error: 'Transcript is too short.' }, 422);

  const { videoTitle, channelName } = extractVideoDetails(html);

  // 4. Call Anthropic
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

  if (!aiRes.ok) return json({ error: `Anthropic API error (${aiRes.status}).` }, 502);
  const aiData = await aiRes.json();
  if (aiData.error) return json({ error: 'Anthropic: ' + aiData.error.message }, 502);

  const raw = aiData.content?.[0]?.text || '';
  const titles = raw.split('\n')
    .map(l => l.replace(/^\d+[\.\)]\s*/, '').trim())
    .filter(l => l.length > 4)
    .slice(0, 5);

  return json({ titles, videoTitle, channelName });
}
