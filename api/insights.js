// ─── api/insights.js ─────────────────────────────────────────────────────────
// Vercel Serverless Function (Node.js 18+)
// Accepts: POST { soil, air, flow, tank, light, ph, imageData? }
// Returns: { detectedPlant, recommendedMoistureThreshold, justification }
// ─────────────────────────────────────────────────────────────────────────────

const GEMINI_API_URL =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

// Agronomic vision system prompt — instructs Gemini to return pure JSON
const SYSTEM_PROMPT = `You are a universal agronomic computer vision engine. Analyze the provided image to identify the plant species present. Based on standard botanical and agricultural science, determine the ideal soil moisture threshold percentage (an integer between 10 and 80) required for this plant to thrive.

You must return your response strictly as a raw JSON object with these keys:
{
  "detectedPlant": "Name of the identified plant",
  "recommendedMoistureThreshold": integer,
  "justification": "A brief one-sentence scientific explanation for this specific threshold requirement."
}

If no plant or organic life is detected in the image at all, return:
{
  "detectedPlant": "Unknown Target",
  "recommendedMoistureThreshold": 35,
  "justification": "No recognizable plant foliage detected. Reverting system to safe default baseline."
}`;

// Text-only fallback prompt used when no image is supplied
const TEXT_PROMPT = (soil, air, flow, tank, light, ph) =>
    `You are an automated agronomic AI for a smart greenhouse. Based on the sensor readings below, infer the most likely plant species present and determine the ideal soil moisture threshold percentage (an integer between 10 and 80) required for this plant to thrive.

Sensor Readings:
- Soil Moisture: ${soil}%
- Air Humidity: ${air}%
- Water Flow: ${flow} L/h
- Tank Level: ${tank}%
- Light Intensity: ${light} lux
- Soil pH: ${ph}

You must return your response strictly as a raw JSON object with these keys:
{
  "detectedPlant": "Name of the identified plant",
  "recommendedMoistureThreshold": integer,
  "justification": "A brief one-sentence scientific explanation for this specific threshold requirement."
}

If no plant or organic life is detected or inferred, return:
{
  "detectedPlant": "Unknown Target",
  "recommendedMoistureThreshold": 35,
  "justification": "No recognizable plant foliage detected. Reverting system to safe default baseline."
}`;

export default async function handler(req, res) {
    // ── CORS headers ─────────────────────────────────────────────────────────
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    if (req.method !== 'POST') {
        res.setHeader('Content-Type', 'application/json');
        return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
    }

    // ── API key guard ────────────────────────────────────────────────────────
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        res.setHeader('Content-Type', 'application/json');
        return res.status(500).json({ error: 'GEMINI_API_KEY environment variable is not set.' });
    }

    // ── Parse request body ───────────────────────────────────────────────────
    const {
        soil   = 0,
        air    = 0,
        flow   = 0,
        tank   = 0,
        light  = 0,
        ph     = 7.0,
        imageData = null   // optional: base64 JPEG string (without the data: prefix)
    } = req.body || {};

    // ── Build Gemini contents array ──────────────────────────────────────────
    let contents;

    if (imageData && typeof imageData === 'string' && imageData.length > 0) {
        // ── Multimodal path: text prompt + inline image ──────────────────────
        // Strip the "data:image/jpeg;base64," prefix if the client sent the full
        // data-URL instead of just the raw base64 payload.
        const rawBase64 = imageData.replace(/^data:[^;]+;base64,/, '');

        contents = [
            {
                role: 'user',
                parts: [
                    {
                        // System instruction embedded as the first text part
                        text: SYSTEM_PROMPT
                    },
                    {
                        // Inline image data block — Gemini multimodal format
                        inline_data: {
                            mime_type: 'image/jpeg',
                            data: rawBase64
                        }
                    }
                ]
            }
        ];
    } else {
        // ── Text-only path: sensor telemetry inference ───────────────────────
        contents = [
            {
                role: 'user',
                parts: [
                    { text: TEXT_PROMPT(soil, air, flow, tank, light, ph) }
                ]
            }
        ];
    }

    // ── Generation config — low temperature for deterministic JSON output ────
    const geminiPayload = {
        contents,
        generationConfig: {
            temperature:     0.2,
            maxOutputTokens: 256,
            topP:            0.9
        }
    };

    // ── Call Gemini API ──────────────────────────────────────────────────────
    try {
        const geminiRes = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(geminiPayload)
        });

        if (!geminiRes.ok) {
            const errText = await geminiRes.text();
            console.error('[insights] Gemini API error:', geminiRes.status, errText);
            res.setHeader('Content-Type', 'application/json');
            return res.status(502).json({
                error:   'Gemini API returned an error.',
                details: errText.slice(0, 400)
            });
        }

        const geminiJson = await geminiRes.json();

        // ── Extract the text candidate ───────────────────────────────────────
        const rawText =
            geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

        // ── Parse and validate JSON from the model output ─────────────────────
        let detectedPlant = 'Unknown Target';
        let recommendedMoistureThreshold = 35;
        let justification = 'No recognizable plant foliage detected. Reverting system to safe default baseline.';

        try {
            const firstBrace = rawText.indexOf('{');
            const lastBrace = rawText.lastIndexOf('}');
            
            if (firstBrace !== -1 && lastBrace !== -1) {
                const cleanText = rawText.substring(firstBrace, lastBrace + 1);
                const parsed = JSON.parse(cleanText);
                
                if (typeof parsed.detectedPlant === 'string' && parsed.detectedPlant.trim() !== '') {
                    detectedPlant = parsed.detectedPlant.trim();
                }
                
                let parsedThreshold = parseInt(parsed.recommendedMoistureThreshold, 10);
                if (!isNaN(parsedThreshold)) {
                    recommendedMoistureThreshold = Math.max(10, Math.min(80, parsedThreshold));
                }
                
                if (typeof parsed.justification === 'string' && parsed.justification.trim() !== '') {
                    justification = parsed.justification.slice(0, 300);
                }
            } else {
                throw new Error("No valid JSON structure found in response");
            }
        } catch (err) {
            console.warn('[insights] Bulletproof extraction failed, using default fallback payload:', err.message);
        }

        // ── Return structured response ────────────────────────────────────────
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).json({
            detectedPlant,
            recommendedMoistureThreshold,
            justification
        });

    } catch (networkErr) {
        console.error('[insights] Network error calling Gemini:', networkErr);
        res.setHeader('Content-Type', 'application/json');
        return res.status(500).json({
            error:   'Internal server error while calling Gemini.',
            details: networkErr.message
        });
    }
}
