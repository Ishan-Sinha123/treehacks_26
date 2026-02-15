import { esClient } from './elasticsearch.js';
import { anthropicApiKey, jinaApiKey } from '../../config.js';

export async function setupInferenceEndpoints() {
    console.log('🔧 Setting up Elasticsearch inference endpoints...');

    // 1. Setup Jina Embeddings
    if (jinaApiKey) {
        try {
            await esClient.transport.request({
                method: 'PUT',
                path: '/_inference/text_embedding/jina_embeddings',
                body: {
                    service: 'jinaai',
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

    // 2. Setup Anthropic (Claude) Chat
    if (anthropicApiKey) {
        try {
            await esClient.transport.request({
                method: 'PUT',
                path: '/_inference/completion/anthropic_completion',
                body: {
                    service: 'anthropic',
                    service_settings: {
                        api_key: anthropicApiKey,
                        model_id: 'claude-sonnet-4-5-20250929',
                    },
                    task_settings: {
                        max_tokens: 1024,
                    },
                },
            });
            console.log('✅ Anthropic (Claude) chat endpoint configured');
        } catch (error) {
            if (error.statusCode === 409 || error.meta?.statusCode === 409) {
                console.log('ℹ️  Anthropic chat endpoint already exists');
            } else {
                console.error(
                    '❌ Failed to configure Anthropic chat:',
                    error.meta?.body || error.message
                );
            }
        }
    } else {
        console.warn('⚠️  ANTHROPIC_API_KEY not set, skipping chat setup');
    }

    console.log('✅ Inference endpoint setup complete');
}
