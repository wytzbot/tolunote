// FILE: api/chat.js
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { prompt, context } = req.body;
    const apiKey = process.env.GROQ_KEY;

    if (!apiKey) {
        return res.status(500).json({ error: 'GROQ_KEY is not configured in environment variables.' });
    }

    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'llama-3.1-8b-instant',
                messages: [
                    { role: 'system', content: 'You are an expert AI productivity assistant inside ToluNote. Help the user rewrite, summarize, expand, or correct their notes.' },
                    { role: 'user', content: `Context:\n${context}\n\nPrompt: ${prompt}` }
                ],
                temperature: 0.7,
                max_tokens: 1024
            })
        });

        const data = await response.json();
        if (data.choices && data.choices[0] && data.choices[0].message) {
            return res.status(200).json({ response: data.choices[0].message.content });
        } else {
            return res.status(500).json({ error: 'Invalid response from Groq API' });
        }
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
            }
