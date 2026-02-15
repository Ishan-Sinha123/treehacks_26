import express from 'express';
import { handleError, sanitize } from '../helpers/routing.js';
import { contextHeader, getAppContext } from '../helpers/cipher.js';
import { getInstallURL } from '../helpers/zoom-api.js';
import { semanticSearch, esClient } from '../helpers/elasticsearch.js';
// Agent network (parked — requires Kibana 9.2 + working Agent Builder)
// import { handleUserChat } from '../helpers/agent-manager.js';

import session from '../session.js';

const router = express.Router();

/*
 * Home Page - Zoom App Launch handler
 * this route is used when a user navigates to the deep link
 */
function isContextExpired(context) {
    const currentTime = Date.now();
    return context.exp && context.exp < currentTime;
}

router.get('/', async (req, res, next) => {
    try {
        sanitize(req);

        const header = req.header(contextHeader);
        const context = header && getAppContext(header);

        if (!context) {
            return res.render('index', {
                isZoom: false,
                title: `Hello Browser`,
            });
        }

        // Check if the context is valid and not expired
        if (isContextExpired(context)) {
            return res
                .status(401)
                .json({ error: 'Invalid or expired context' });
        }

        return res.render('index', {
            isZoom: true,
            title: 'Context Assistant',
            chatHistory: [],
            chatTarget: 'Meeting',
        });
    } catch (e) {
        next(handleError(e));
    }
});

/*
 * Install Route - Install the Zoom App from the Zoom Marketplace
 * this route is used when a user installs the app from the Zoom Client
 */
router.get('/install', session, async (req, res) => {
    const { url, state, verifier } = getInstallURL();
    req.session.state = state;
    req.session.verifier = verifier;
    res.redirect(url.href);
});

/*
 * Chat Route - Semantic search + Anthropic inference
 * (Agent network version parked — swap back when Kibana is ready)
 */
router.post('/chat', async (req, res, next) => {
    try {
        sanitize(req);

        const { message } = req.body;

        if (!message || typeof message !== 'string' || message.trim() === '') {
            return res
                .status(400)
                .json({ success: false, error: 'Message is required' });
        }

        // 1. Semantic search across all transcript chunks
        let relevantChunks = [];
        try {
            relevantChunks = await semanticSearch(message, null, null, 5);
        } catch (err) {
            console.warn('Semantic search failed during chat:', err.message);
        }

        const chunksText = relevantChunks
            .map(
                (c) =>
                    `[${c.speaker_names?.join(', ') || 'Unknown'}]: ${c.text}`
            )
            .join('\n---\n')
            .substring(0, 4000);

        // 2. Build prompt with context + question
        const prompt = `You are an AI assistant helping a meeting participant understand what's being discussed in their current meeting. Answer questions based on the transcript excerpts provided.

${
    chunksText
        ? `Relevant transcript excerpts:\n${chunksText}\n\n`
        : 'No transcript data available yet.\n\n'
}Question: ${message}

Answer concisely and helpfully based on the meeting context provided. If there is no relevant context, say so.`;

        // 3. Call Anthropic via ES inference
        try {
            const completion = await esClient.transport.request({
                method: 'POST',
                path: '/_inference/completion/anthropic_completion',
                body: { input: prompt },
            });

            const answer =
                completion.completion?.[0]?.result || 'No response generated.';

            return res.json({ success: true, response: answer });
        } catch (inferenceError) {
            console.warn('Inference endpoint error:', inferenceError.message);

            if (relevantChunks.length > 0) {
                const fallback = relevantChunks
                    .map(
                        (c) =>
                            `${c.speaker_names?.join(', ') || 'Unknown'}: "${
                                c.text
                            }"`
                    )
                    .join('\n\n');
                return res.json({
                    success: true,
                    response: `I found relevant transcript excerpts but the AI inference endpoint is not available. Here's what was said:\n\n${fallback}`,
                });
            }

            return res.json({
                success: true,
                response:
                    'The AI inference endpoint is not configured yet. Please set up the Elasticsearch Anthropic inference endpoint.',
            });
        }
    } catch (e) {
        next(handleError(e));
    }
});

export default router;
