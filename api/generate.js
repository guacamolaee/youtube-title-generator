export const config = { runtime: 'edge' };

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const SUPADATA_KEY  = process.env.SUPADATA_KEY;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 200 });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  if (!ANTHROPIC_KEY) return json({ error: 'ANTHROPIC_KEY not set.' }, 500);
  if (!SUPADATA_KEY)  return json({ error: 'SUPADATA_KEY not set.' }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON.' }, 400); }

  const { videoId } = body || {};
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return json({ error: 'Invalid video ID.' }, 400);
  }

  // 1. Fetch transcript via Supadata
  const supRes = await fetch(
    `https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}&text=true`,
    { headers: { 'x-api-key': SUPADATA_KEY } }
  );

  if (!supRes.ok) {
    const err = await supRes.text();
    return json({ error: `Could not fetch transcript (${supRes.status}). The video may have no captions or be private.` }, 404);
  }

  const supData = await supRes.json();
  const transcript = typeof supData.content === 'string'
    ? supData.content.trim()
    : (supData.content || []).map(c => c.text).join(' ').trim();

  if (!transcript || transcript.length < 50) {
    return json({ error: 'Transcript is too short or empty.' }, 422);
  }

  // 2. Call Anthropic
  const prompt = `You are a YouTube title optimization expert.
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

  return json({ titles, videoTitle: '', channelName: '' });
}
