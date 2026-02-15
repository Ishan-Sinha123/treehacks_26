import {
    esClient,
    getSpeakerContext,
    upsertSpeakerContext,
} from './elasticsearch.js';

/**
 * Summarize a speaker's recent statements via ES Anthropic inference endpoint.
 * Fetches prior summary from speaker_context, merges with new text, and upserts.
 */
export async function summarizeSpeaker({
    meetingId,
    speakerId,
    speakerName,
    recentText,
    segmentCount,
}) {
    // Fetch prior summary if it exists
    const prior = await getSpeakerContext(speakerId, meetingId);
    const priorSummary = prior?.context_summary || '';

    const prompt = `You are summarizing what ${speakerName} has said in a meeting.

${
    priorSummary ? `Previous summary of this speaker:\n${priorSummary}\n\n` : ''
}New statements from ${speakerName}:
${recentText}

Provide a concise updated summary of everything ${speakerName} has discussed. Include key points, positions, and any action items. Also list 1-3 topic keywords. Respond in JSON: { "summary": "...", "topics": ["..."] }`;

    const result = await esClient.transport.request({
        method: 'POST',
        path: '/_inference/completion/anthropic_completion',
        body: { input: prompt },
    });

    const parsed = parseClaudeResponse(result);

    // Upsert into speaker_context index
    await upsertSpeakerContext(
        speakerId,
        speakerName,
        meetingId,
        parsed.summary,
        parsed.topics,
        segmentCount
    );

    return parsed;
}

function parseClaudeResponse(result) {
    try {
        const text =
            result.completion?.[0]?.result ||
            result.completion?.result ||
            (typeof result.completion === 'string' ? result.completion : '');

        // Try to extract JSON from the response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
                summary: parsed.summary || text,
                topics: Array.isArray(parsed.topics) ? parsed.topics : [],
            };
        }

        // Fallback: use the raw text as summary
        return { summary: text, topics: [] };
    } catch (error) {
        console.error('⚠️ Failed to parse Claude response:', error.message);
        return { summary: 'Summary generation failed', topics: [] };
    }
}
