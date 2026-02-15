import http from 'http';
import debug from 'debug';
import { appName } from '../config.js';
import { testConnection, initializeIndices } from './helpers/elasticsearch.js';
import { setupInferenceEndpoints } from './helpers/setup-inference.js';

const dbg = debug(`${appName}:http`);

/**
 * Start the HTTP server
 * @param app - Express app to attach to
 * @param {String|number} port - local TCP port to serve from
 */
export async function start(app, port) {
    // Initialize Elasticsearch before starting server
    console.log('🔄 Connecting to Elasticsearch...');
    const connected = await testConnection();

    if (connected) {
        // Inference endpoints must exist before creating indices
        // (transcript_chunks needs jina_embeddings for semantic_text field)
        await setupInferenceEndpoints();

        console.log('🔄 Initializing Elasticsearch indices...');
        await initializeIndices();
        console.log('✅ Elasticsearch ready');
    } else {
        console.warn(
            '⚠️  Elasticsearch not available - some features will be disabled'
        );
    }

    // Create HTTP server
    const server = http.createServer(app);

    // let the user know when we're serving
    server.on('listening', () => {
        const addr = server.address();
        const bind =
            typeof addr === 'string'
                ? `pipe ${addr}`
                : `http://localhost:${addr.port}`;
        dbg(`Listening on ${bind}`);
    });

    server.on('error', async (error) => {
        if (error?.syscall !== 'listen') throw error;
        const bind = typeof port === 'string' ? `Pipe ${port}` : `Port ${port}`;
        // handle specific listen errors with friendly messages
        switch (error?.code) {
            case 'EACCES':
                throw new Error(`${bind} requires elevated privileges`);
            case 'EADDRINUSE':
                throw new Error(`${bind} is already in use`);
            default:
                throw error;
        }
    });

    // Listen on provided port, on all network interfaces
    return server.listen(port);
}
