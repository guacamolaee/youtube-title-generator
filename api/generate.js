const { YoutubeTranscript } = require('youtube-transcript');

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;

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

  // 1. Fetch transcript
  let transcriptItems;
  try {
    transcriptItems = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'en' });
  } catch (e) {
    try {
      transcriptItems = await YoutubeTranscript.fetchTranscript(videoId);
    } catch (e2) {
      return res.status(404).json({ error: 'Could not fetch transcript. The video may have no captions, be private, or age-restricted.' });
    }
  }

  if (!transcriptItems || !transcriptItems.length) {
    return res.status(404).json({ error: 'No transcript found for this video.' });
  }

  const transcript = transcriptItems
    .map(item => item.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (transcript.length < 50) {
    return res.status(422).json({ error: 'Transcript is too short.' });
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

  if (!aiRes.ok) return res.status(502).json({ error: `Anthropic API error (${aiRes.status}).` });
  const aiData = await aiRes.json();
  if (aiData.error) return res.status(502).json({ error: 'Anthropic: ' + aiData.error.message });

  const raw = (aiData.content && aiData.content[0] && aiData.content[0].text) || '';
  const titles = raw.split('\n')
    .map(l => l.replace(/^\d+[\.\)]\s*/, '').trim())
    .filter(l => l.length > 4)
    .slice(0, 5);

  res.status(200).json({ titles, videoTitle: '', channelName: '' });
};
