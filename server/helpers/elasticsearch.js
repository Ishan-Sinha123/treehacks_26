import { Client } from '@elastic/elasticsearch';
import { elasticsearchUrl } from '../../config.js';

const esClient = new Client({
    node: elasticsearchUrl,
    requestTimeout: 30000,
    maxRetries: 5,
});

// Readiness gate — resolves once indices are initialized
let indicesReady;
const indicesReadyPromise = new Promise((resolve) => {
    indicesReady = resolve;
});

// Test connection with retries
export async function testConnection(retries = 5) {
    for (let i = 0; i < retries; i++) {
        try {
            const health = await esClient.cluster.health();
            console.log('✅ Elasticsearch connected:', health.status);
            return true;
        } catch (error) {
            console.error(
                `❌ Elasticsearch connection attempt ${
                    i + 1
                }/${retries} failed:`,
                error.message
            );
            if (i < retries - 1) {
                console.log(`⏳ Retrying in 3 seconds...`);
                await new Promise((resolve) => setTimeout(resolve, 3000));
            }
        }
    }
    console.error('❌ Elasticsearch connection failed after all retries');
    return false;
}

// Initialize indices (run on startup)
export async function initializeIndices() {
    const indices = [
        {
            name: 'meetings',
            mappings: {
                properties: {
                    meeting_id: { type: 'keyword' },
                    meeting_uuid: { type: 'keyword' },
                    start_time: { type: 'date' },
                    end_time: { type: 'date' },
                    participants: { type: 'keyword' },
                    status: { type: 'keyword' },
                },
            },
        },
        {
            name: 'transcript_chunks',
            mappings: {
                properties: {
                    meeting_id: { type: 'keyword' },
                    speaker_ids: { type: 'keyword' },
                    speaker_names: { type: 'keyword' },
                    start_time: { type: 'date' },
                    end_time: { type: 'date' },
                    text: {
                        type: 'semantic_text',
                        inference_id: 'jina_embeddings',
                    },
                    chunk_id: { type: 'keyword' },
                },
            },
        },
        {
            name: 'speaker_transcripts',
            mappings: {
                properties: {
                    speaker_id: { type: 'keyword' },
                    speaker_name: { type: 'keyword' },
                    meeting_id: { type: 'keyword' },
                    text: { type: 'text' },
                    timestamp: { type: 'date' },
                },
            },
        },
        {
            name: 'speaker_context',
            mappings: {
                properties: {
                    speaker_id: { type: 'keyword' },
                    speaker_name: { type: 'text' },
                    meeting_id: { type: 'keyword' },
                    context_summary: { type: 'text' },
                    topics: { type: 'keyword' },
                    last_updated: { type: 'date' },
                    segment_count: { type: 'integer' },
                },
            },
        },
    ];

    for (const index of indices) {
        try {
            const exists = await esClient.indices.exists({ index: index.name });
            if (exists) {
                // Check if transcript_chunks has the correct semantic_text mapping
                if (index.name === 'transcript_chunks') {
                    const mapping = await esClient.indices.getMapping({
                        index: index.name,
                    });
                    const textType =
                        mapping[index.name]?.mappings?.properties?.text?.type;
                    if (textType !== 'semantic_text') {
                        console.log(
                            `⚠️  ${index.name} has text type "${textType}" instead of "semantic_text" — recreating`
                        );
                        await esClient.indices.delete({ index: index.name });
                        await esClient.indices.create({
                            index: index.name,
                            mappings: index.mappings,
                        });
                        console.log(
                            `✅ Recreated index: ${index.name} with semantic_text`
                        );
                        continue;
                    }
                }
                console.log(`ℹ️  Index already exists: ${index.name}`);
            } else {
                await esClient.indices.create({
                    index: index.name,
                    mappings: index.mappings,
                });
                console.log(`✅ Created index: ${index.name}`);
            }
        } catch (error) {
            console.error(
                `❌ Failed to create index ${index.name}:`,
                error.message
            );
        }
    }

    indicesReady();
}

// Insert a transcript chunk — ES auto-embeds via semantic_text
export async function insertTranscriptChunk(chunk) {
    await indicesReadyPromise;
    try {
        const result = await esClient.index({
            index: 'transcript_chunks',
            document: chunk,
        });
        console.log(`✅ Inserted transcript chunk: ${chunk.chunk_id}`);
        return result;
    } catch (error) {
        console.error('❌ Error inserting transcript chunk:', error);
        throw error;
    }
}

// Insert a raw speaker utterance into speaker_transcripts
export async function insertSpeakerTranscript(utterance) {
    await indicesReadyPromise;
    try {
        await esClient.index({
            index: 'speaker_transcripts',
            document: {
                speaker_id: utterance.speaker_id,
                speaker_name: utterance.speaker_name,
                meeting_id: utterance.meeting_id,
                text: utterance.text,
                timestamp: utterance.timestamp,
            },
        });
    } catch (error) {
        console.error('❌ Error inserting speaker transcript:', error.message);
    }
}

// Search transcript chunks — tries semantic search first, falls back to text match
export async function semanticSearch(query, meetingId, speakerId, size = 10) {
    await indicesReadyPromise;

    const filter = [];
    if (speakerId) filter.push({ term: { speaker_ids: speakerId } });

    // Try semantic search first (requires jina_embeddings + semantic_text field)
    try {
        const must = [{ semantic: { field: 'text', query } }];
        const result = await esClient.search({
            index: 'transcript_chunks',
            query: { bool: { must, filter } },
            size,
        });
        return result.hits.hits.map((h) => ({ ...h._source, score: h._score }));
    } catch {
        // Fallback to regular text match
    }

    try {
        const must = [{ match: { text: query } }];
        const result = await esClient.search({
            index: 'transcript_chunks',
            query: { bool: { must, filter } },
            size,
        });
        return result.hits.hits.map((h) => ({ ...h._source, score: h._score }));
    } catch (error) {
        console.error('❌ Error in text search:', error.message);
        throw error;
    }
}

// Upsert speaker context (summary + topics)
export async function upsertSpeakerContext(
    speakerId,
    speakerName,
    meetingId,
    summary,
    topics,
    segmentCount
) {
    await indicesReadyPromise;
    try {
        const docId = `${meetingId}-${speakerId}`;
        const result = await esClient.index({
            index: 'speaker_context',
            id: docId,
            document: {
                speaker_id: speakerId,
                speaker_name: speakerName,
                meeting_id: meetingId,
                context_summary: summary,
                topics,
                last_updated: new Date().toISOString(),
                segment_count: segmentCount,
            },
        });
        console.log(`✅ Upserted speaker context: ${speakerName} (${docId})`);
        return result;
    } catch (error) {
        console.error('❌ Error upserting speaker context:', error);
        throw error;
    }
}

// Get speaker context from speaker_context index
export async function getSpeakerContext(speakerId, meetingId) {
    await indicesReadyPromise;
    try {
        const docId = `${meetingId}-${speakerId}`;
        const result = await esClient.get({
            index: 'speaker_context',
            id: docId,
        });
        return result._source;
    } catch (error) {
        if (error.meta?.statusCode === 404) {
            return null;
        }
        console.error('❌ Error getting speaker context:', error);
        throw error;
    }
}

// Create/update meeting
export async function upsertMeeting(meetingData) {
    try {
        const result = await esClient.index({
            index: 'meetings',
            id: meetingData.meeting_id,
            document: meetingData,
        });
        return result;
    } catch (error) {
        console.error('Error upserting meeting:', error);
        throw error;
    }
}

export { esClient };
