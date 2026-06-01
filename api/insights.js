// ─── api/insights.js ─────────────────────────────────────────────────────────
// Vercel Serverless Function (Node.js 18+)
// Accepts: POST { soil, air, flow, tank, light, ph, imageData? }
// Returns: { detectedPlant, recommendedMoistureThreshold, justification }
// ─────────────────────────────────────────────────────────────────────────────

const GEMINI_API_URL =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

// Agronomic vision system prompt — instructs Gemini to return pure JSON
const SYSTEM_PROMPT = `You are an automated agronomic vision system for a smart greenhouse.
Analyze the image frame provided to identify if the plant is 'Rosemary' or 'Lemongrass'.
Based on your botanical knowledge, output your response strictly as a raw JSON object (no markdown, no code fences) containing exactly these keys:
{
  "detectedPlant": "Rosemary" or "Lemongrass",
  "recommendedMoistureThreshold": integer between 0 and 100,
  "justification": "one sentence explanation"
}`;

// Text-only fallback prompt used when no image is supplied
const TEXT_PROMPT = (soil, air, flow, tank, light, ph) =>
    `You are an automated agronomic AI for a smart greenhouse. Based on the sensor readings below, infer the most likely plant species (Rosemary or Lemongrass) and recommend an optimal soil moisture irrigation threshold.

Sensor Readings:
- Soil Moisture: ${soil}%
- Air Humidity: ${air}%
- Water Flow: ${flow} L/h
- Tank Level: ${tank}%
- Light Intensity: ${light} lux
- Soil pH: ${ph}

Output your response strictly as a raw JSON object (no markdown, no code fences):
{
  "detectedPlant": "Rosemary" or "Lemongrass",
  "recommendedMoistureThreshold": integer between 0 and 100,
  "justification": "one sentence explanation"
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

        // ── Parse JSON from the model output ────────────────────────────────
        // Gemini may wrap the JSON in ```json ... ``` — strip that safely.
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            console.error('[insights] No JSON found in Gemini response:', rawText);
            res.setHeader('Content-Type', 'application/json');
            return res.status(422).json({
                error:   'Could not parse a JSON object from the model response.',
                rawText: rawText.slice(0, 400)
            });
        }

        let parsed;
        try {
            parsed = JSON.parse(jsonMatch[0]);
        } catch (parseErr) {
            console.error('[insights] JSON.parse failed:', parseErr.message, jsonMatch[0]);
            res.setHeader('Content-Type', 'application/json');
            return res.status(422).json({
                error:   'JSON parse error on model output.',
                rawText: rawText.slice(0, 400)
            });
        }

        // ── Validate and sanitise the payload ────────────────────────────────
        const detectedPlant = ['Rosemary', 'Lemongrass'].includes(parsed.detectedPlant)
            ? parsed.detectedPlant
            : 'Rosemary';

        const recommendedMoistureThreshold = Math.max(
            0,
            Math.min(100, parseInt(parsed.recommendedMoistureThreshold, 10) || 30)
        );

        const justification =
            typeof parsed.justification === 'string'
                ? parsed.justification.slice(0, 300)
                : 'No justification provided.';

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
