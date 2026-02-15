import express from 'express';
import { handleError, sanitize } from '../helpers/routing.js';
import {
    getSpeakerContext,
    semanticSearch,
    esClient,
} from '../helpers/elasticsearch.js';
import { getMeetingUuid } from './webhook.js';

const router = express.Router();

/**
 * Feature 1: Get speaker context (generated summary)
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

        // Translate numeric meeting ID → UUID
        const uuid = await getMeetingUuid(meetingId);
        const queryId = uuid || meetingId;

        const context = await getSpeakerContext(speakerId, queryId);

        if (!context) {
            return res.json({
                speaker_id: speakerId,
                meeting_id: meetingId,
                context_summary: null,
                message: 'No summary available yet for this speaker.',
            });
        }

        res.json(context);
    } catch (e) {
        next(handleError(e));
    }
});

/**
 * Feature 2: Chat with speaker context
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

        // Translate numeric meeting ID → UUID
        const uuid = await getMeetingUuid(meetingId);
        const queryId = uuid || meetingId;

        // 1. Get speaker summary from speaker_context
        const context = await getSpeakerContext(speakerId, queryId);
        const summary = context?.context_summary || '';

        // 2. Semantic search scoped to this speaker for relevant chunks
        let relevantChunks = [];
        try {
            relevantChunks = await semanticSearch(
                question,
                queryId,
                speakerId,
                5
            );
        } catch (err) {
            console.warn('Semantic search failed during chat:', err.message);
        }

        const chunksText = relevantChunks
            .map((c) => c.text)
            .join('\n---\n')
            .substring(0, 3000);

        // 3. Build prompt with summary + relevant chunks + question
        const prompt = `You are answering questions about what a speaker said in a meeting.

${summary ? `Speaker summary:\n${summary}\n\n` : ''}${
            chunksText ? `Relevant transcript excerpts:\n${chunksText}\n\n` : ''
        }Question: ${question}

Answer concisely based on the context provided.`;

        // 4. Call Anthropic via ES inference
        try {
            const completion = await esClient.transport.request({
                method: 'POST',
                path: '/_inference/completion/anthropic_completion',
                body: { input: prompt },
            });

            res.json({
                answer:
                    completion.completion?.[0]?.result ||
                    'No response generated',
                speaker_id: speakerId,
            });
        } catch (inferenceError) {
            console.warn(
                'Inference endpoint not configured:',
                inferenceError.message
            );
            res.json({
                answer: 'Chat feature requires Elasticsearch Anthropic inference endpoint to be configured.',
                speaker_id: speakerId,
                context_available: !!summary,
            });
        }
    } catch (e) {
        next(handleError(e));
    }
});

/**
 * Feature 3: Semantic search across transcript chunks
 * POST /api/semantic-search
 * Body: { query: string, meetingId?: string, speakerId?: string, size?: number }
 */
router.post('/semantic-search', async (req, res, next) => {
    try {
        sanitize(req);
        const { query, meetingId, speakerId, size = 10 } = req.body;

        if (!query) {
            return res.status(400).json({ error: 'query required' });
        }

        // Translate numeric meeting ID → UUID if provided
        const uuid = meetingId ? await getMeetingUuid(meetingId) : null;
        const queryId = uuid || meetingId;

        try {
            const results = await semanticSearch(
                query,
                queryId,
                speakerId,
                size
            );

            res.json({
                query,
                results: results.map((r) => ({
                    text: r.text,
                    speaker_names: r.speaker_names,
                    start_time: r.start_time,
                    end_time: r.end_time,
                    chunk_id: r.chunk_id,
                    score: r.score,
                })),
            });
        } catch (inferenceError) {
            console.warn('Semantic search failed:', inferenceError.message);
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
 * Get all speakers for a meeting
 * GET /api/meeting/:meetingId/speakers
 */
router.get('/meeting/:meetingId/speakers', async (req, res, next) => {
    try {
        sanitize(req);
        const { meetingId } = req.params;

        // Frontend sends numeric meeting ID, ES stores UUID — translate
        const uuid = await getMeetingUuid(meetingId);
        const queryId = uuid || meetingId;
        console.log(
            `🔎 GET /api/meeting/${meetingId}/speakers → querying ES with meeting_id="${queryId}" (translated: ${!!uuid})`
        );

        const result = await esClient.search({
            index: 'speaker_context',
            body: {
                query: { term: { meeting_id: queryId } },
                sort: [{ last_updated: 'desc' }],
                size: 50,
            },
        });

        const speakers = result.hits.hits.map((hit) => hit._source);
        console.log(
            `🔎 GET /api/meeting/${meetingId}/speakers → found ${speakers.length} speakers`
        );
        res.json({ meeting_id: meetingId, uuid: queryId, speakers });
    } catch (e) {
        next(handleError(e));
    }
});

/**
 * Get all chunks for a meeting (debugging/demo)
 * GET /api/chunks/:meetingId
 */
router.get('/chunks/:meetingId', async (req, res, next) => {
    try {
        sanitize(req);
        const { meetingId } = req.params;

        // Translate numeric meeting ID → UUID
        const uuid = await getMeetingUuid(meetingId);
        const queryId = uuid || meetingId;

        const result = await esClient.search({
            index: 'transcript_chunks',
            body: {
                query: { match: { meeting_id: queryId } },
                sort: [{ start_time: 'asc' }],
                size: 1000,
            },
        });

        const chunks = result.hits.hits.map((hit) => hit._source);
        res.json({ meeting_id: meetingId, total: chunks.length, chunks });
    } catch (e) {
        next(handleError(e));
    }
});

export default router;
