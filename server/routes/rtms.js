import express from 'express';
import { WebSocketServer } from 'ws';
import debug from 'debug';
import { appName } from '../../config.js';
import { bulkInsertSegments } from '../helpers/elasticsearch.js';

const router = express.Router();
const dbg = debug(`${appName}:rtms`);

// Store active WebSocket connections
const activeConnections = new Map();

/**
 * Initialize WebSocket server for RTMS
 * @param {http.Server} server - HTTP server instance
 */
export function initializeRTMSWebSocket(server) {
    const wss = new WebSocketServer({
        server,
        path: '/rtms',
    });

    wss.on('connection', (ws, req) => {
        const meetingId = req.url.split('?meetingId=')[1];

        if (!meetingId) {
            dbg('❌ No meeting ID provided');
            ws.close(1008, 'Meeting ID required');
            return;
        }

        dbg(`✅ RTMS WebSocket connected for meeting: ${meetingId}`);

        // Store connection
        activeConnections.set(meetingId, {
            ws,
            batch: [],
            batchTimer: null,
        });

        ws.on('message', async (data) => {
            try {
                const transcript = JSON.parse(data.toString());
                dbg(
                    `📝 Received transcript from ${
                        transcript.speaker_name || 'Unknown'
                    }`
                );

                const connection = activeConnections.get(meetingId);
                if (!connection) return;

                // Add to batch
                const segment = {
                    meeting_id: meetingId,
                    speaker_id: transcript.speaker_id || transcript.userId,
                    speaker_name:
                        transcript.speaker_name || transcript.userName,
                    text: transcript.text,
                    timestamp: new Date(transcript.timestamp || Date.now()),
                    segment_id: `${meetingId}-${Date.now()}-${Math.random()
                        .toString(36)
                        .substr(2, 9)}`,
                };

                connection.batch.push(segment);

                // Clear existing timer
                if (connection.batchTimer) {
                    clearTimeout(connection.batchTimer);
                }

                // Set new timer to flush batch after 1 second
                connection.batchTimer = setTimeout(async () => {
                    if (connection.batch.length > 0) {
                        dbg(
                            `📤 Flushing ${connection.batch.length} segments to Elasticsearch`
                        );

                        try {
                            await bulkInsertSegments(connection.batch);
                            dbg(
                                `✅ Inserted ${connection.batch.length} segments`
                            );

                            // TODO: Trigger ES inference pipeline for summarization and embedding
                            // This will be done via ES ingest pipeline once we configure inference endpoints
                        } catch (error) {
                            console.error('Error inserting segments:', error);
                        }

                        connection.batch = [];
                    }
                }, 1000);
            } catch (error) {
                console.error('Error processing RTMS message:', error);
            }
        });

        ws.on('close', () => {
            dbg(`🔌 RTMS WebSocket closed for meeting: ${meetingId}`);
            const connection = activeConnections.get(meetingId);

            if (connection) {
                // Flush any remaining segments
                if (connection.batch.length > 0) {
                    bulkInsertSegments(connection.batch).catch(console.error);
                }

                if (connection.batchTimer) {
                    clearTimeout(connection.batchTimer);
                }

                activeConnections.delete(meetingId);
            }
        });

        ws.on('error', (error) => {
            console.error('RTMS WebSocket error:', error);
        });
    });

    dbg('✅ RTMS WebSocket server initialized');
}

export default router;
