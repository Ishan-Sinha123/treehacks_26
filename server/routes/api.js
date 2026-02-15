import express from 'express';
import { handleError, sanitize } from '../helpers/routing.js';
import {
    getSpeakerContext,
    vectorSearch,
    esClient,
} from '../helpers/elasticsearch.js';

const router = express.Router();

/**
 * Feature 1: Get speaker context
 * GET /api/speaker/:speakerId/context?meetingId=XXX
 */
router.get('/speaker/:speakerId/context', async (req, res, next) => {
    try {
        sanitize(req);
        const { speakerId } = req.params;
        const { meetingId } = req.query;

        if (!meetingId) {
            return res.status(400).json({ error: 'meetingId required' });
        }

        const segments = await getSpeakerContext(speakerId, meetingId);

        // Aggregate into context summary
        const context = {
            speaker_id: speakerId,
            meeting_id: meetingId,
            total_segments: segments.length,
            segments: segments.map((s) => ({
                text: s.text,
                summary: s.summary,
                timestamp: s.timestamp,
            })),
        };

        res.json(context);
    } catch (e) {
        next(handleError(e));
    }
});

/**
 * Feature 2: Get topic stack for meeting
 * GET /api/topics/:meetingId
 */
router.get('/topics/:meetingId', async (req, res, next) => {
    try {
        sanitize(req);
        const { meetingId } = req.params;

        const result = await esClient.search({
            index: 'topic_stack',
            body: {
                query: { match: { meeting_id: meetingId } },
                sort: [{ start_time: 'asc' }],
            },
        });

        const topics = result.hits.hits.map((hit) => hit._source);
        res.json({ meeting_id: meetingId, topics });
    } catch (e) {
        next(handleError(e));
    }
});

/**
 * Feature 3: Chat with speaker context
 * POST /api/chat/:speakerId
 * Body: { question: string, meetingId: string }
 */
router.post('/chat/:speakerId', async (req, res, next) => {
    try {
        sanitize(req);
        const { speakerId } = req.params;
        const { question, meetingId } = req.body;

        if (!question || !meetingId) {
            return res
                .status(400)
                .json({ error: 'question and meetingId required' });
        }

        // Get speaker context
        const segments = await getSpeakerContext(speakerId, meetingId);
        const context = segments.map((s) => s.text).join('\n');

        // Call ES inference API for chat completion using Anthropic
        try {
            const prompt = `Context from speaker:\n${context.substring(
                0,
                3000
            )}\n\nQuestion: ${question}`;

            const completion = await esClient.transport.request({
                method: 'POST',
                path: '/_inference/completion/anthropic_completion',
                body: {
                    input: prompt,
                },
            });

            res.json({
                answer:
                    completion.completion?.[0]?.result ||
                    'No response generated',
                speaker_id: speakerId,
            });
        } catch (inferenceError) {
            // Fallback if inference endpoint not configured
            console.warn(
                'Inference endpoint not configured:',
                inferenceError.message
            );
            res.json({
                answer: 'Chat feature requires Elasticsearch Anthropic inference endpoint to be configured.',
                speaker_id: speakerId,
                context_available: segments.length > 0,
            });
        }
    } catch (e) {
        next(handleError(e));
    }
});

/**
 * Feature 4: Semantic search for similar segments
 * POST /api/semantic-search
 * Body: { query: string, meetingId?: string, k?: number }
 */
router.post('/semantic-search', async (req, res, next) => {
    try {
        sanitize(req);
        const { query, meetingId, k = 5 } = req.body;

        if (!query) {
            return res.status(400).json({ error: 'query required' });
        }

        // Generate query embedding via ES inference
        try {
            const embeddingResult = await esClient.inference.inference({
                inference_id: 'jina_embeddings',
                input: query,
            });

            const queryEmbedding = embeddingResult.inference?.[0]?.embedding;

            if (!queryEmbedding) {
                throw new Error('No embedding generated');
            }

            // Perform vector search
            const results = await vectorSearch(queryEmbedding, meetingId, k);

            res.json({
                query,
                results: results.map((r) => ({
                    text: r.text,
                    summary: r.summary,
                    speaker_name: r.speaker_name,
                    timestamp: r.timestamp,
                    similarity_score: r.score,
                })),
            });
        } catch (inferenceError) {
            console.warn(
                'Inference endpoint not configured:',
                inferenceError.message
            );
            res.json({
                query,
                results: [],
                message:
                    'Semantic search requires Elasticsearch inference endpoint to be configured.',
            });
        }
    } catch (e) {
        next(handleError(e));
    }
});

/**
 * Get all segments for a meeting (for debugging/demo)
 * GET /api/segments/:meetingId
 */
router.get('/segments/:meetingId', async (req, res, next) => {
    try {
        sanitize(req);
        const { meetingId } = req.params;

        const result = await esClient.search({
            index: 'transcript_segments',
            body: {
                query: { match: { meeting_id: meetingId } },
                sort: [{ timestamp: 'asc' }],
                size: 1000,
            },
        });

        const segments = result.hits.hits.map((hit) => hit._source);
        res.json({ meeting_id: meetingId, total: segments.length, segments });
    } catch (e) {
        next(handleError(e));
    }
});

export default router;
