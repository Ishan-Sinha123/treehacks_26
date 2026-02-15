import { kibanaUrl, kibanaApiKey } from '../../config.js';
import { esClient } from './elasticsearch.js';

// In-memory cache of speaker agents: speakerId → { agentId, speakerName }
const agentCache = new Map();

// Kibana connector ID (set during initializeTools)
let connectorId = null;

// Whether tools have been initialized
let toolsReady = false;

/**
 * Make an authenticated request to the Kibana API
 */
async function kibanaRequest(method, path, body) {
    const url = `${kibanaUrl}${path}`;
    const headers = {
        'kbn-xsrf': 'true',
        'Content-Type': 'application/json',
    };
    if (kibanaApiKey) {
        headers['Authorization'] = `ApiKey ${kibanaApiKey}`;
    }

    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    const text = await res.text();

    let json;
    try {
        json = JSON.parse(text);
    } catch {
        json = null;
    }

    if (!res.ok) {
        const msg = json?.message || text || res.statusText;
        throw new Error(
            `Kibana ${method} ${path} failed (${res.status}): ${msg}`
        );
    }

    return json;
}

/**
 * Ensure the LLM connector exists in Kibana (uses ES inference endpoint).
 * Returns the connector ID.
 */
async function ensureConnector() {
    // Check if connector already exists
    try {
        const connectors = await kibanaRequest(
            'GET',
            '/api/actions/connectors'
        );
        const existing = connectors.find(
            (c) =>
                c.name === 'Anthropic via ES' &&
                c.connector_type_id === '.inference'
        );
        if (existing) {
            console.log(`ℹ️  Kibana connector already exists: ${existing.id}`);
            return existing.id;
        }
    } catch (err) {
        console.warn('Could not list connectors:', err.message);
    }

    // Create new connector
    const result = await kibanaRequest('POST', '/api/actions/connector', {
        connector_type_id: '.inference',
        name: 'Anthropic via ES',
        config: {
            inferenceId: 'anthropic_completion',
            taskType: 'completion',
            provider: 'anthropic',
        },
    });

    console.log(`✅ Created Kibana connector: ${result.id}`);
    return result.id;
}

/**
 * Create shared tools in Kibana Agent Builder (run once on startup).
 * - search-transcripts: ES|QL query for speaker_transcripts
 * - search-chunks: index search on transcript_chunks
 */
export async function initializeTools() {
    if (!kibanaUrl) {
        console.warn('⚠️  KIBANA_URL not set — agent network disabled');
        return;
    }

    try {
        // 1. Ensure LLM connector
        connectorId = await ensureConnector();

        // 2. Create search-transcripts tool (ES|QL)
        try {
            await kibanaRequest(
                'PUT',
                '/api/agent_builder/tools/search-transcripts',
                {
                    name: 'search-transcripts',
                    description:
                        'Search speaker_transcripts index for utterances by a specific speaker. Use this to find what your human said.',
                    type: 'esql',
                    configuration: {
                        query: 'FROM speaker_transcripts | WHERE speaker_id == ?speaker_id | SORT timestamp DESC | LIMIT ?limit',
                        parameters: {
                            speaker_id: {
                                type: 'string',
                                description: 'The speaker ID to search for',
                            },
                            limit: {
                                type: 'number',
                                description: 'Max results to return',
                                default: 20,
                            },
                        },
                    },
                }
            );
            console.log('✅ Created tool: search-transcripts');
        } catch (err) {
            if (
                err.message.includes('409') ||
                err.message.includes('already exists')
            ) {
                console.log('ℹ️  Tool search-transcripts already exists');
            } else {
                console.warn(
                    '⚠️  Failed to create search-transcripts tool:',
                    err.message
                );
            }
        }

        // 3. Create search-chunks tool (index search)
        try {
            await kibanaRequest(
                'PUT',
                '/api/agent_builder/tools/search-chunks',
                {
                    name: 'search-chunks',
                    description:
                        'Semantic search across all transcript chunks from all meetings and speakers.',
                    type: 'index_search',
                    configuration: {
                        index: 'transcript_chunks',
                    },
                }
            );
            console.log('✅ Created tool: search-chunks');
        } catch (err) {
            if (
                err.message.includes('409') ||
                err.message.includes('already exists')
            ) {
                console.log('ℹ️  Tool search-chunks already exists');
            } else {
                console.warn(
                    '⚠️  Failed to create search-chunks tool:',
                    err.message
                );
            }
        }

        toolsReady = true;
        console.log('✅ Agent network tools initialized');
    } catch (err) {
        console.error('❌ Failed to initialize agent tools:', err.message);
    }
}

/**
 * Create an agent for a speaker if one doesn't already exist.
 */
export async function ensureAgentExists(speakerId, speakerName) {
    if (!toolsReady || !kibanaUrl) return null;

    const key = String(speakerId);
    if (agentCache.has(key)) return agentCache.get(key).agentId;

    const agentId = `agent-${key}`;

    try {
        // Check if agent already exists
        try {
            const existing = await kibanaRequest(
                'GET',
                `/api/agent_builder/agents/${agentId}`
            );
            if (existing) {
                agentCache.set(key, { agentId, speakerName });
                console.log(
                    `ℹ️  Agent already exists: ${agentId} (${speakerName})`
                );
                return agentId;
            }
        } catch {
            // 404 means we need to create it
        }

        await kibanaRequest('PUT', `/api/agent_builder/agents/${agentId}`, {
            id: agentId,
            name: `${speakerName}'s Digital Twin`,
            configuration: {
                connector_id: connectorId,
                tools: [{ tool_ids: ['search-transcripts', 'search-chunks'] }],
                instructions: `You are the digital twin of ${speakerName} (speaker_id: ${speakerId}). You represent them in a network of AI agents. Your role: 1) Know everything your human has said across all meetings. 2) Answer questions about their positions, priorities, and knowledge. 3) When queried by other agents, share relevant context. 4) Identify conflicts or synergies with other participants. Use search-transcripts with your speaker_id to find your human's utterances.`,
            },
        });

        agentCache.set(key, { agentId, speakerName });
        console.log(`✅ Agent created: ${agentId} (${speakerName})`);
        return agentId;
    } catch (err) {
        console.error(
            `❌ Failed to create agent for ${speakerName}:`,
            err.message
        );
        return null;
    }
}

/**
 * Send a message to an agent and get a response.
 */
export async function queryAgent(agentId, message, conversationId) {
    const body = {
        agent_id: agentId,
        input: message,
    };
    if (conversationId) body.conversation_id = conversationId;

    const result = await kibanaRequest(
        'POST',
        '/api/agent_builder/converse',
        body
    );
    return result?.output || result?.message || '';
}

/**
 * Query all agents in the network except the excluded one.
 * Returns an array of { speakerName, agentId, response }.
 */
export async function queryAgentNetwork(question, excludeAgentId) {
    const agents = Array.from(agentCache.values()).filter(
        (a) => a.agentId !== excludeAgentId
    );

    if (agents.length === 0) return [];

    const results = await Promise.allSettled(
        agents.map(async (agent) => {
            const prompt = `What does your human know about: ${question}`;
            const response = await queryAgent(agent.agentId, prompt);
            return {
                speakerName: agent.speakerName,
                agentId: agent.agentId,
                response,
            };
        })
    );

    return results
        .filter((r) => r.status === 'fulfilled' && r.value.response)
        .map((r) => r.value);
}

/**
 * Full chat orchestration:
 * 1. Identify user's agent
 * 2. Query all other agents for context
 * 3. Build enriched prompt
 * 4. Send to user's agent
 * 5. Return response
 */
export async function handleUserChat(speakerName, message) {
    if (!toolsReady || !kibanaUrl) {
        throw new Error('Agent network not initialized');
    }

    // 1. Find speaker's ID from speaker_context
    let speakerId = null;
    try {
        const result = await esClient.search({
            index: 'speaker_context',
            query: { match: { speaker_name: speakerName } },
            size: 1,
        });
        speakerId = result.hits.hits[0]?._source?.speaker_id;
    } catch {
        // Try speaker_transcripts as fallback
        try {
            const result = await esClient.search({
                index: 'speaker_transcripts',
                query: { match: { speaker_name: speakerName } },
                size: 1,
            });
            speakerId = result.hits.hits[0]?._source?.speaker_id;
        } catch {
            // no speaker found
        }
    }

    if (!speakerId) {
        throw new Error(
            `No speaker found with name "${speakerName}". Start speaking in the meeting first.`
        );
    }

    // 2. Ensure the user's agent exists
    const userAgentId = await ensureAgentExists(speakerId, speakerName);
    if (!userAgentId) {
        throw new Error('Failed to create agent for user');
    }

    // 3. Query all other agents in parallel
    const networkResponses = await queryAgentNetwork(message, userAgentId);

    // 4. Build enriched prompt
    let enrichedPrompt = `User asks: ${message}\n\n`;

    if (networkResponses.length > 0) {
        enrichedPrompt += 'Context from other agents:\n';
        for (const nr of networkResponses) {
            enrichedPrompt += `- ${nr.speakerName}'s agent: ${nr.response}\n`;
        }
        enrichedPrompt +=
            '\nAnswer using your knowledge of the user and the context above.';
    } else {
        enrichedPrompt +=
            'No other agents are available yet. Answer using your own knowledge of the user.';
    }

    // 5. Send enriched prompt to user's agent
    const response = await queryAgent(userAgentId, enrichedPrompt);
    return response;
}

export default {
    initializeTools,
    ensureAgentExists,
    queryAgent,
    queryAgentNetwork,
    handleUserChat,
};
