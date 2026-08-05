// Vercel serverless function
// Gates access with a Payhip license key, then calls Claude with a server-side
// API key that only you hold. The buyer never sees or needs an API key.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { bizName, clientName, jobType, jobNotes, items, licenseKey } = req.body || {};

  if (!licenseKey) {
    return res.status(400).json({ error: 'Missing license key' });
  }

  // 1. Verify the license key against Payhip
  let verifyData;
  try {
    const verifyRes = await fetch(
      `https://payhip.com/api/v2/license/verify?license_key=${encodeURIComponent(licenseKey)}`,
      {
        method: 'GET',
        headers: { 'product-secret-key': process.env.PAYHIP_PRODUCT_SECRET_KEY },
      }
    );
    // Payhip returns an empty/error body on invalid keys rather than a clean 4xx
    const text = await verifyRes.text();
    verifyData = text ? JSON.parse(text) : null;
  } catch (err) {
    return res.status(500).json({ error: 'License verification service unreachable' });
  }

  if (!verifyData || !verifyData.data || verifyData.data.enabled !== true) {
    return res.status(403).json({ error: 'Invalid license key' });
  }

  // Safety ceiling only — not meant to be a tight per-purchase limit.
  // Payhip tracks `uses` on the key. At Haiku pricing, even 200 quotes on
  // one key costs well under $1, so this exists purely to block a runaway
  // script or bot, not to ration real buyers.
  const maxUses = 200;
  if (verifyData.data.uses && verifyData.data.uses > maxUses) {
    return res.status(403).json({ error: 'This key has hit its safety limit — contact support for a fresh key.' });
  }

  // 2. Build the prompt
  const itemsText = (items && items.length)
    ? items.map(i => `- ${i.desc} | qty: ${i.qty || '1'} | unit price: ${i.price || 'TBD'}`).join('\n')
    : '(no line items provided — invent reasonable ones based on the job scope)';

  const prompt = `You are drafting a short, professional job quote for a tradesperson to send to a client.

Business: ${bizName}
Client: ${clientName}
Job type: ${jobType || 'not specified'}
Job notes: ${jobNotes || 'not specified'}

Line items given:
${itemsText}

Write two things, clearly separated:
1. A 2-3 sentence professional cover note to the client, in the tradesperson's voice — plain, confident, no fluff.
2. A finalized list of line items in the format "Description | Qty | Unit Price | Line Total" — one per line, using the given items as a base (fill in reasonable estimates only where marked TBD or missing, using typical market rates for this trade). Do not invent extra padding items. End with a TOTAL line.

Respond ONLY in this exact JSON shape, nothing else, no markdown fences:
{"cover_note": "...", "items": [{"desc":"...","qty":"...","price":"...","total":"..."}], "total": "..."}`;

  // 3. Call Claude with your own server-side key
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: 'AI generation failed: ' + errText.slice(0, 200) });
    }

    const data = await response.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    let raw = textBlock ? textBlock.text : '{}';
    raw = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(raw);

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
