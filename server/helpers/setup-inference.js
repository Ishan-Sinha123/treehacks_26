import { esClient } from './elasticsearch.js';
import { openaiApiKey, anthropicApiKey, jinaApiKey } from '../../config.js';

export async function setupInferenceEndpoints() {
    console.log('🔧 Setting up Elasticsearch inference endpoints...');

    // 1. Setup Jina Embeddings
    if (jinaApiKey) {
        try {
            await esClient.transport.request({
                method: 'PUT',
                path: '/_inference/text_embedding/jina-embeddings',
                body: {
                    service: 'jina',
                    service_settings: {
                        api_key: jinaApiKey,
                        model_id: 'jina-embeddings-v3',
                    },
                },
            });
            console.log('✅ Jina embeddings endpoint configured');
        } catch (error) {
            if (error.statusCode === 409 || error.meta?.statusCode === 409) {
                console.log('ℹ️  Jina embeddings endpoint already exists');
            } else {
                console.error(
                    '❌ Failed to configure Jina embeddings:',
                    error.meta?.body || error.message
                );
            }
        }
    } else {
        console.warn('⚠️  JINA_API_KEY not set, skipping embeddings setup');
    }

    // 2. Setup OpenAI Chat (if available)
    if (openaiApiKey) {
        try {
            await esClient.transport.request({
                method: 'PUT',
                path: '/_inference/completion/openai-chat',
                body: {
                    service: 'openai',
                    service_settings: {
                        api_key: openaiApiKey,
                        model_id: 'gpt-4o-mini',
                    },
                },
            });
            console.log('✅ OpenAI chat endpoint configured');
        } catch (error) {
            if (error.statusCode === 409 || error.meta?.statusCode === 409) {
                console.log('ℹ️  OpenAI chat endpoint already exists');
            } else {
                console.error(
                    '❌ Failed to configure OpenAI chat:',
                    error.meta?.body || error.message
                );
            }
        }
    }

    // 3. Setup Anthropic Chat (if available)
    if (anthropicApiKey) {
        try {
            await esClient.transport.request({
                method: 'PUT',
                path: '/_inference/completion/claude-chat',
                body: {
                    service: 'anthropic',
                    service_settings: {
                        api_key: anthropicApiKey,
                        model_id: 'claude-sonnet-4-20250514',
                    },
                },
            });
            console.log('✅ Claude chat endpoint configured');
        } catch (error) {
            if (error.statusCode === 409 || error.meta?.statusCode === 409) {
                console.log('ℹ️  Claude chat endpoint already exists');
            } else {
                console.error(
                    '❌ Failed to configure Claude chat:',
                    error.meta?.body || error.message
                );
            }
        }
    }

    if (!openaiApiKey && !anthropicApiKey) {
        console.warn('⚠️  No LLM API key set, skipping chat setup');
    }

    console.log('✅ Inference endpoint setup complete');
}
