import { Client } from '@elastic/elasticsearch';
import { elasticsearchUrl } from '../../config.js';

const esClient = new Client({
    node: elasticsearchUrl,
    requestTimeout: 30000,
});

// Test connection
export async function testConnection() {
    try {
        const health = await esClient.cluster.health();
        console.log('✅ Elasticsearch connected:', health.status);
        return true;
    } catch (error) {
        console.error('❌ Elasticsearch connection failed:', error.message);
        return false;
    }
}

// Initialize indices (run on startup)
export async function initializeIndices() {
    const indices = [
        {
            name: 'meetings',
            mappings: {
                properties: {
                    meeting_id: { type: 'keyword' },
                    start_time: { type: 'date' },
                    end_time: { type: 'date' },
                    participants: { type: 'keyword' },
                    status: { type: 'keyword' },
                },
            },
        },
        {
            name: 'transcript_segments',
            mappings: {
                properties: {
                    meeting_id: { type: 'keyword' },
                    speaker_id: { type: 'keyword' },
                    speaker_name: { type: 'text' },
                    timestamp: { type: 'date' },
                    text: { type: 'text' },
                    summary: { type: 'text' },
                    embedding: {
                        type: 'dense_vector',
                        dims: 1024, // Jina embeddings v3
                        index: true,
                        similarity: 'cosine',
                    },
                    segment_id: { type: 'keyword' },
                },
            },
        },
        {
            name: 'speaker_context',
            mappings: {
                properties: {
                    speaker_id: { type: 'keyword' },
                    meeting_id: { type: 'keyword' },
                    context_summary: { type: 'text' },
                    topics: { type: 'keyword' },
                    last_updated: { type: 'date' },
                },
            },
        },
        {
            name: 'topic_stack',
            mappings: {
                properties: {
                    meeting_id: { type: 'keyword' },
                    topic: { type: 'keyword' },
                    start_time: { type: 'date' },
                    end_time: { type: 'date' },
                    segment_ids: { type: 'keyword' },
                },
            },
        },
    ];

    for (const index of indices) {
        try {
            const exists = await esClient.indices.exists({ index: index.name });
            if (!exists) {
                await esClient.indices.create({
                    index: index.name,
                    body: { mappings: index.mappings },
                });
                console.log(`✅ Created index: ${index.name}`);
            } else {
                console.log(`ℹ️  Index already exists: ${index.name}`);
            }
        } catch (error) {
            console.error(
                `❌ Failed to create index ${index.name}:`,
                error.message
            );
        }
    }
}

// Insert transcript segment
export async function insertTranscriptSegment(segment) {
    try {
        const result = await esClient.index({
            index: 'transcript_segments',
            body: segment,
        });
        return result;
    } catch (error) {
        console.error('Error inserting transcript segment:', error);
        throw error;
    }
}

// Bulk insert transcript segments
export async function bulkInsertSegments(segments) {
    const body = segments.flatMap((doc) => [
        { index: { _index: 'transcript_segments' } },
        doc,
    ]);

    try {
        const result = await esClient.bulk({ body, refresh: true });
        return result;
    } catch (error) {
        console.error('Error bulk inserting segments:', error);
        throw error;
    }
}

// Search speaker context
export async function getSpeakerContext(speakerId, meetingId) {
    try {
        const result = await esClient.search({
            index: 'transcript_segments',
            body: {
                query: {
                    bool: {
                        must: [
                            { match: { speaker_id: speakerId } },
                            { match: { meeting_id: meetingId } },
                        ],
                    },
                },
                sort: [{ timestamp: 'desc' }],
                size: 100,
            },
        });
        return result.hits.hits.map((hit) => hit._source);
    } catch (error) {
        console.error('Error getting speaker context:', error);
        throw error;
    }
}

// Vector search for similar segments
export async function vectorSearch(embedding, meetingId = null, k = 5) {
    const query = {
        knn: {
            field: 'embedding',
            query_vector: embedding,
            k,
            num_candidates: 100,
        },
    };

    if (meetingId) {
        query.filter = { term: { meeting_id: meetingId } };
    }

    try {
        const result = await esClient.search({
            index: 'transcript_segments',
            body: query,
        });
        return result.hits.hits.map((hit) => ({
            ...hit._source,
            score: hit._score,
        }));
    } catch (error) {
        console.error('Error in vector search:', error);
        throw error;
    }
}

// Update segment with summary and embedding (will be populated by ES inference)
export async function updateSegment(segmentId, updates) {
    try {
        const result = await esClient.update({
            index: 'transcript_segments',
            id: segmentId,
            body: {
                doc: {
                    ...updates,
                    processed_at: new Date(),
                },
            },
        });
        return result;
    } catch (error) {
        console.error('Error updating segment:', error);
        throw error;
    }
}

// Create/update meeting
export async function upsertMeeting(meetingData) {
    try {
        const result = await esClient.index({
            index: 'meetings',
            id: meetingData.meeting_id,
            body: meetingData,
        });
        return result;
    } catch (error) {
        console.error('Error upserting meeting:', error);
        throw error;
    }
}

export { esClient };
