// Vercel serverless function: sends the plant photo to Google Gemini and returns a structured diagnosis.
// The API key lives only in Vercel's environment variables (GEMINI_API_KEY) - never in the web page.

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const MAX_IMAGE_CHARS = 4 * 1024 * 1024; // base64 characters

const PROMPT = (crop) => `You are an assistant for smallholder farmers in Malawi, helping to identify problems on ${crop} plants from a photo.

Look carefully at the photo and answer ONLY with one JSON object (no markdown, no extra text) with exactly these keys:
{
  "image_ok": true or false,          // false if the photo is too blurry, dark, far away, or not a plant
  "detected_crop": "maize" | "sugarcane" | "other" | "not a plant",
  "crop_matches": true or false,      // does the plant look like ${crop}?
  "condition": "short name of the most likely disease, pest, deficiency, damage or 'Healthy'",
  "type": "healthy" | "disease" | "pest" | "nutrient_or_other" | "unclear",
  "confidence": "low" | "medium" | "high",
  "severity": "none" | "low" | "medium" | "high" | "critical",
  "what_you_see": "1-2 plain sentences describing the visible symptoms that led to your answer",
  "alternatives": ["up to 2 other possible conditions, or empty list"],
  "actions": ["3 to 5 short, practical steps a smallholder farmer can take"],
  "prevention": "1-2 sentences"
}

Rules:
- Be honest. If you are not sure, use confidence "low" and type "unclear". Never invent a diagnosis.
- Base the answer only on what is visible in the photo.
- Do NOT give pesticide product names, brand names, doses or mixing rates. You may say that a registered product may be needed and that the farmer should ask an agricultural extension officer.
- Always include, as the last action, a step to confirm with a local agricultural extension officer when the condition is not "Healthy".
- Use simple English.`;

const ENUMS = {
  detected_crop: ['maize', 'sugarcane', 'other', 'not a plant'],
  type: ['healthy', 'disease', 'pest', 'nutrient_or_other', 'unclear'],
  confidence: ['low', 'medium', 'high'],
  severity: ['none', 'low', 'medium', 'high', 'critical'],
};

function pick(value, allowed, fallback) {
  const v = String(value || '').toLowerCase().trim();
  return allowed.includes(v) ? v : fallback;
}

function text(value, max) {
  return String(value == null ? '' : value).slice(0, max);
}

function list(value, maxItems, maxLen) {
  return Array.isArray(value) ? value.slice(0, maxItems).map((x) => text(x, maxLen)).filter(Boolean) : [];
}

function cleanResult(raw) {
  const type = pick(raw.type, ENUMS.type, 'unclear');
  const confidence = pick(raw.confidence, ENUMS.confidence, 'low');
  return {
    image_ok: raw.image_ok !== false,
    detected_crop: pick(raw.detected_crop, ENUMS.detected_crop, 'other'),
    crop_matches: raw.crop_matches !== false,
    condition: text(raw.condition, 120) || 'Unknown',
    type,
    confidence,
    severity: pick(raw.severity, ENUMS.severity, type === 'healthy' ? 'none' : 'medium'),
    what_you_see: text(raw.what_you_see, 500),
    alternatives: list(raw.alternatives, 2, 120),
    actions: list(raw.actions, 6, 300),
    prevention: text(raw.prevention, 500),
  };
}

function parseModelJson(output) {
  const cleaned = String(output).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON found');
  return JSON.parse(cleaned.slice(start, end + 1));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST.' });
  }
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'The AI service is not configured yet (missing key).' });
  }

  const body = req.body || {};
  const crop = String(body.crop || '').toLowerCase();
  const image = String(body.image || '');

  if (!['maize', 'sugarcane'].includes(crop)) {
    return res.status(400).json({ error: 'Please choose maize or sugarcane.' });
  }
  const match = image.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  if (!match || match[2].length > MAX_IMAGE_CHARS) {
    return res.status(400).json({ error: 'Please send a valid photo (JPEG, PNG or WebP, under 3 MB).' });
  }

  let response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': process.env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: PROMPT(crop) },
                { inline_data: { mime_type: match[1], data: match[2] } },
              ],
            },
          ],
          generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
        }),
      }
    );
  } catch (err) {
    return res.status(502).json({ error: 'Could not reach the AI service. Please try again.' });
  }

  if (response.status === 429) {
    return res.status(429).json({ error: 'The free AI limit was reached. Please wait a minute and try again.' });
  }
  if (!response.ok) {
    console.error('Gemini error', response.status, (await response.text()).slice(0, 300));
    return res.status(502).json({ error: `The AI service returned an error (${response.status}).` });
  }

  try {
    const data = await response.json();
    const output = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    if (!output) throw new Error('Empty answer');
    const result = cleanResult(parseModelJson(output));
    return res.status(200).json({ crop, ...result });
  } catch (err) {
    console.error('Could not read AI answer:', err.message);
    return res.status(502).json({ error: 'The AI could not analyse this photo. Please try a clearer one.' });
  }
};
